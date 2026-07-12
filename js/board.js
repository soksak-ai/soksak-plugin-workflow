// Projecting the ledger onto an issue board — soksak-issue-board-spec@1.
//
// The board is discovered by contract, never by name: the ledger must not know which plugin draws
// its cards, and a different board must be able to take over by declaring the same contract.
//
// The board is a projection, never a source of truth. Nothing here reads a card back into the
// ledger, and a missing board is not an error — the loop runs, unwatched, exactly as before. A
// producer that fails without its board has made the board load-bearing, which the contract forbids.

export const BOARD_CONTRACT = "soksak-issue-board-spec@1";

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

  async function implementer() {
    const out = await exec("plugin.implementers", { contract: BOARD_CONTRACT });
    if (!out?.ok) return null;
    const found = (out.data?.implementers || []).find((i) => i.status === "enabled");
    return found ? found.id : null;
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
      const id = await implementer();
      if (!id) return { projected: false, reason: "no board implements the contract" };
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
      const id = await implementer();
      if (!id) {
        await store.del(issue); // no board holds it any more; the mapping is meaningless
        return { withdrawn: false, reason: "no board implements the contract" };
      }
      const out = await exec(`plugin.${id}.node.remove`, { node: mapped.nodeId });
      if (!out?.ok) return { withdrawn: false, nodeId: mapped.nodeId, reason: `${out?.code}: ${out?.message}` };
      await store.del(issue);
      return { withdrawn: true, nodeId: mapped.nodeId };
    },
  };
}
