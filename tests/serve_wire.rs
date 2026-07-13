//! serve 와이어 왕복 통합 테스트(PS17) — `serve` 서브커맨드를 실제 프로세스로 스폰해
//! stdio NDJSON 로 hello→ready→req→res→shutdown 왕복을 **프로세스 경계**에서 증명한다.
//! deps(kanban 중개)·LLM 을 건드리지 않는 결정적 op(즉시 InvalidParams·UnknownOp)만 사용한다 —
//! deps 왕복·타임아웃은 proto 크레이트 serve 하니스 유닛이 이미 mock core 로 고정한다.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdout, Command, Stdio};

fn spawn_serve() -> Child {
    Command::new(env!("CARGO_BIN_EXE_soksak-sidecar-workflow"))
        .arg("serve")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("serve 스폰")
}

// res 프레임을 id 매칭까지 읽는다(중간 ev/act/cmd 프레임 스킵). EOF 면 패닉.
fn read_res(stdout: &mut BufReader<ChildStdout>, want_id: u64) -> Value {
    loop {
        let mut line = String::new();
        let n = stdout.read_line(&mut line).expect("stdout read");
        assert!(n > 0, "res(id={want_id}) 전에 EOF");
        let f: Value = serde_json::from_str(line.trim()).expect("frame JSON");
        if f["t"] == "res" && f["id"].as_u64() == Some(want_id) {
            return f;
        }
    }
}

#[test]
fn serve_hello_req_shutdown_roundtrip() {
    let mut child = spawn_serve();
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    // ── hello(PS5) — 하니스가 와이어 interface + 선언 ops 를 채운다(저자 재기술 0) ──
    let mut line = String::new();
    stdout.read_line(&mut line).expect("hello read");
    let hello: Value = serde_json::from_str(line.trim()).expect("hello JSON");
    assert_eq!(hello["t"], "hello", "첫 줄 = hello");
    assert_eq!(hello["interface"], "soksak-spec-service@0.0.1", "와이어 interface");
    assert_eq!(hello["version"], 1, "프로토콜 판");
    let ops: Vec<String> = hello["ops"]
        .as_array()
        .expect("ops 배열")
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    for op in ["run", "ping", "reconcile", "research", "next", "submit", "issuerize", "export"] {
        assert!(ops.contains(&op.to_string()), "hello.ops 에 {op} 선언");
    }
    let subs: Vec<String> = hello["subscribe"]
        .as_array()
        .expect("subscribe 배열")
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    // 구독 토픽은 보드 계약이 소유한다. 구현체 이름이 박힌 토픽은 이름-핀이고, 보드를 갈아끼우면
    // 에러 하나 없이 구독이 끊긴다 — 그래서 여기서 이름의 부재까지 함께 못박는다.
    assert!(subs.iter().any(|s| s == "bus:issue-board:changed"), "subscribe 에 보드 계약 토픽(PS15)");
    assert!(!subs.iter().any(|s| s.contains("kanban")), "구독 토픽에 구현체 이름이 있으면 이름-핀이다");

    // ── ready → 서비스는 req 수신 개시 ──
    writeln!(stdin, "{}", json!({"t":"ready"})).unwrap();
    stdin.flush().unwrap();

    // ── req#1: issuerize(chunk 없음) → 즉시 InvalidParams(deps·LLM 미접촉) ──
    let req = json!({"t":"req","id":1,"op":"issuerize","params":{},"key":"k1","ctx":{"origin":"socket","deadlineMs":10000}});
    writeln!(stdin, "{req}").unwrap();
    stdin.flush().unwrap();
    let res = read_res(&mut stdout, 1);
    assert_eq!(res["ok"], false, "issuerize chunk 없음 → 실패");
    assert_eq!(res["code"], "INVALID_PARAMS", "폐쇄 ErrCode 매핑");

    // ── req#2: 미지 op → UnknownOp(폐쇄 enum, raw 문자열 누출 0) ──
    let req = json!({"t":"req","id":2,"op":"bogus","params":{},"key":"k2","ctx":{"origin":"socket","deadlineMs":10000}});
    writeln!(stdin, "{req}").unwrap();
    stdin.flush().unwrap();
    let res = read_res(&mut stdout, 2);
    assert_eq!(res["ok"], false, "미지 op → 실패");
    assert_eq!(res["code"], "UNKNOWN_OP");

    // ── req#3: 멱등키 재사용(k1) → 캐시 res 재생(PS12) ──
    let req = json!({"t":"req","id":3,"op":"issuerize","params":{},"key":"k1","ctx":{"origin":"socket","deadlineMs":10000}});
    writeln!(stdin, "{req}").unwrap();
    stdin.flush().unwrap();
    let res = read_res(&mut stdout, 3);
    assert_eq!(res["ok"], false, "멱등 재생도 동일 봉투");
    assert_eq!(res["code"], "INVALID_PARAMS", "키 k1 캐시 res 재생");

    // ── shutdown → 드레인·정상 종료(PS10) ──
    writeln!(stdin, "{}", json!({"t":"shutdown"})).unwrap();
    stdin.flush().unwrap();
    drop(stdin);
    let status = child.wait().expect("종료 대기");
    assert!(status.success(), "shutdown 후 종료코드 0");
}
