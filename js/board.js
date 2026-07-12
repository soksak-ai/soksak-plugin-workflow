// Projecting the ledger onto an issue board — soksak-issue-board-spec@1.
//
// The board is discovered by contract, never by name: the ledger must not know which plugin draws
// its cards, and a different board must be able to take over by declaring the same contract.
//
// The board is a projection, never a source of truth. Nothing here reads a card back into the
// ledger, and a missing board is not an error — the loop runs, unwatched, exactly as before. A
// producer that fails without its board has made the board load-bearing, which the contract forbids.

export const BOARD_CONTRACT = "soksak-issue-board-spec@1";
export const PROMPT_CONTRACT = "soksak-prompt-store-spec@1";

// The loop needs both contracts from *one* plugin: a node carries the address of the prompt it runs,
// and an address minted by one store means nothing to another. So the implementer is the intersection
// of the two discoveries — never the first board that answers.
//
// Pure, so the choice can be judged without an app: given what each discovery returned, this is the
// plugin that can hold both the card and the text the card points at.
export function pickImplementer(boards, stores) {
  const enabled = (xs) => (Array.isArray(xs) ? xs : []).filter((i) => i?.status === "enabled").map((i) => i.id);
  const holdsPrompts = new Set(enabled(stores));
  return enabled(boards).find((id) => holdsPrompts.has(id)) ?? null;
}

// The card a ledger entry projects to. Pure: the same entry always yields the same card, so a
// re-projection can be compared against what is already on the board.
//
//   backlog     — on the ledger, nobody holding it
//   inprogress  — someone holds a live lease right now
//   done        — the transition gate let it through, which means its receipts were real
export function cardOf(entry, leaseState) {
  const receipts = entry.receipts || [];
  const status = entry.done ? "done" : leaseState === "live" ? "inprogress" : "backlog";
  const parts = [];
  if (entry.lease?.owner) parts.push(leaseState === "live" ? `held by ${entry.lease.owner}` : `lease lapsed (${entry.lease.owner})`);
  else parts.push("unheld");
  if (entry.branch) parts.push(entry.branch);
  parts.push(receipts.length === 1 ? "1 receipt" : `${receipts.length} receipts`);
  const commits = receipts.filter((r) => r.kind === "commit").map((r) => String(r.value).slice(0, 7));
  if (commits.length > 0) parts.push(commits.join(" "));
  return { title: entry.issue, description: parts.join(" · "), status };
}

// Discovery + upsert against whatever implements the contract. The consumer owns the issue→card
// mapping (the board issues its own ids), and re-checks the card still exists: a human may delete a
// card, and a mapping to a card that is gone would silently stop projecting.
// The card every issue hangs under. A board is shared — a ledger that scatters its issues among
// everyone else's cards cannot be read at a glance, which is the only thing a board is for.
export const LEDGER_CARD = "workflow ledger";
const ROOT_KEY = "\u0000root"; // reserved: never an issue id

export function makeBoard(app, store) {
  const exec = (name, params) => app.commands.execute(name, params);

  // Resolved at call time, so a board that was installed, swapped, or disabled since the last
  // projection is seen as it is now. The two answers below are different facts and must not be
  // collapsed:
  //   { id: null }                  nothing implements the board contract — lawful. The ledger is
  //                                 the truth and the card is downstream of it; the loop runs on.
  //   { id: null, code, reason }    a board IS running, but nothing implements both contracts. That
  //                                 is not "no board", it is a board this loop cannot use, and
  //                                 swallowing it as the lawful state would hide a misconfiguration.
  async function implementer() {
    const b = await exec("plugin.implementers", { contract: BOARD_CONTRACT });
    const p = await exec("plugin.implementers", { contract: PROMPT_CONTRACT });
    if (!b?.ok || !p?.ok) return { id: null };
    const boards = b.data?.implementers || [];
    const id = pickImplementer(boards, p.data?.implementers);
    if (id) return { id };
    if (!boards.some((i) => i?.status === "enabled")) return { id: null };
    return {
      id: null,
      code: "UNAVAILABLE",
      reason: `a board is running, but none implements ${PROMPT_CONTRACT} — a card carries the address of the prompt its node runs, so the board holding the card must be the store holding the text`,
    };
  }

  async function alive(id, nodeId) {
    const got = await exec(`plugin.${id}.node.get`, { node: nodeId });
    return !!got?.ok;
  }

  // The group the issues hang under, made once and remembered. If a human deletes it, the next
  // projection makes a new one rather than scattering its cards across the board.
  async function ledgerCard(id) {
    const mapped = await store.get(ROOT_KEY);
    if (mapped?.nodeId && (await alive(id, mapped.nodeId))) return mapped.nodeId;
    const added = await exec(`plugin.${id}.node.add`, { title: LEDGER_CARD, status: "backlog" });
    if (!added?.ok) return null;
    await store.put(ROOT_KEY, { nodeId: added.data?.nodeId, board: id });
    return added.data?.nodeId;
  }

  return {
    implementer,
    ledgerCard,

    /** Put the entry on the board (create or update). No board → nothing happens, and that is fine. */
    async project(entry, leaseState) {
      const { id, code, reason } = await implementer();
      if (!id) return { projected: false, code, reason: reason ?? "no board implements the contract" };
      const card = cardOf(entry, leaseState);
      const mapped = await store.get(entry.issue);

      if (mapped?.nodeId && (await alive(id, mapped.nodeId))) {
        const edited = await exec(`plugin.${id}.node.edit`, { node: mapped.nodeId, ...card });
        if (edited?.ok) return { projected: true, nodeId: mapped.nodeId, card };
      }
      const parentId = await ledgerCard(id);
      const added = await exec(`plugin.${id}.node.add`, parentId ? { ...card, parentId } : card);
      if (!added?.ok) return { projected: false, reason: `${added?.code}: ${added?.message}` };
      const nodeId = added.data?.nodeId;
      await store.put(entry.issue, { nodeId, board: id });
      return { projected: true, nodeId, card };
    },

    /** Withdraw the card. A dropped issue that keeps its card would be a leak on someone's screen —
     *  so a refused withdrawal is reported, never swallowed: the mapping is kept, because forgetting
     *  it while the card still stands would strand the card forever with nothing pointing at it. */
    async unproject(issue) {
      const mapped = await store.get(issue);
      if (!mapped?.nodeId) return { withdrawn: false };
      const { id, code, reason } = await implementer();
      if (!id) {
        // A board that cannot run the loop is still a board, and it may still be showing this card.
        // Forgetting the mapping would strand it there with nothing pointing at it — so the mapping
        // is kept and the refusal is reported. Only when no board exists at all is the mapping
        // meaningless, because the card went with it.
        if (code) return { withdrawn: false, nodeId: mapped.nodeId, code, reason };
        await store.del(issue);
        return { withdrawn: false, reason: "no board implements the contract" };
      }
      const out = await exec(`plugin.${id}.node.remove`, { node: mapped.nodeId });
      if (!out?.ok) return { withdrawn: false, nodeId: mapped.nodeId, reason: `${out?.code}: ${out?.message}` };
      await store.del(issue);
      return { withdrawn: true, nodeId: mapped.nodeId };
    },
  };
}
