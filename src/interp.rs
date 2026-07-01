//! interp — 완전 skeleton(program = 중립 AST)을 해석하는 런타임.
//! 추출기 가 파서/렉서로 떠낸 workflow-skeleton.program(ESTree AST)을 tree-walk 해석한다.
//! 런타임은 워크플로 로직을 모른다 — program 을 해석할 뿐. agent 만 host(claude -p 인증 프로필)로 위임.
//! parallel/pipeline/phase/log/workflow 는 engine 계약대로 실행(barrier/no-barrier/progress).
//! async/await/Promise 는 동기 eager 모델(정확성 보존, 동시성은 후속) — agent 가 블로킹 호출.
//!
//! [원칙] 내 손코딩한 워크플로별 로직·하드코딩 수치 0. program 이 시키는 대로만. agent 수는
//! program 이 정한다(내가 N 안 정함).

use serde_json::Value as Json;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

// ── 런타임 값 ──
#[derive(Clone)]
pub enum Val {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Rc<RefCell<Vec<Val>>>),
    Obj(Rc<RefCell<BTreeMap<String, Val>>>),
    Func(Rc<Closure>),
    Native(String), // 내장 함수(Boolean/String/Number 등) — filter(Boolean) 같은 콜백 전달용.
}

pub struct Closure {
    pub params: Vec<String>,
    pub body: Json,      // BlockStatement 또는 expression(arrow 단문)
    pub is_block: bool,  // body 가 BlockStatement 인가
    pub scope: Scope,
}

// ── 스코프(렉시컬, Rc 체인) ──
#[derive(Clone)]
pub struct Scope(Rc<ScopeInner>);
struct ScopeInner {
    vars: RefCell<BTreeMap<String, Val>>,
    parent: Option<Scope>,
}
impl Scope {
    fn root() -> Scope {
        Scope(Rc::new(ScopeInner { vars: RefCell::new(BTreeMap::new()), parent: None }))
    }
    fn child(&self) -> Scope {
        Scope(Rc::new(ScopeInner { vars: RefCell::new(BTreeMap::new()), parent: Some(self.clone()) }))
    }
    fn declare(&self, name: &str, v: Val) {
        self.0.vars.borrow_mut().insert(name.to_string(), v);
    }
    fn get(&self, name: &str) -> Option<Val> {
        if let Some(v) = self.0.vars.borrow().get(name) {
            return Some(v.clone());
        }
        self.0.parent.as_ref().and_then(|p| p.get(name))
    }
    fn set(&self, name: &str, v: Val) -> bool {
        if self.0.vars.borrow().contains_key(name) {
            self.0.vars.borrow_mut().insert(name.to_string(), v);
            return true;
        }
        match &self.0.parent {
            Some(p) => p.set(name, v),
            None => {
                // 미선언 할당 → 전역에 생성(느슨, JS 비-strict).
                self.0.vars.borrow_mut().insert(name.to_string(), v);
                true
            }
        }
    }
}

// ── host: agent(LLM) + 진행 표시. parallel/pipeline 은 인터프리터 내장(클로저 호출). ──
pub trait Host {
    /// agent(prompt, opts) → 구조화 출력(또는 null). prompt=String, opts=Obj(label/schema/model…).
    fn agent(&mut self, prompt: &str, opts: &BTreeMap<String, Val>) -> Result<Val, String>;
    fn phase(&mut self, title: &str);
    fn log(&mut self, msg: &str);
    /// 워크플로 노드 발행용 그룹 경계 — parallel/pipeline 진입/진출(부모키·blockedBy 추적).
    /// default no-op: agent 실행 Host(ClaudeHost)는 영향 없음 — 발행 호스트만 override.
    fn group_enter(&mut self, _kind: &str) {}
    fn group_exit(&mut self) {}
    /// pipeline 의 한 item 이 stage 체인을 시작/끝낼 때(blockedBy 체인 경계). default no-op.
    fn stage_boundary(&mut self) {}
}

// 제어 흐름.
enum Flow {
    Normal,
    Return(Val),
}

pub struct Interp<'a, H: Host> {
    host: &'a mut H,
}

impl<'a, H: Host> Interp<'a, H> {
    pub fn new(host: &'a mut H) -> Self {
        Interp { host }
    }

    /// run — program(AST) 실행. args 를 전역 `args` 로 주입. 반환값(workflow return) 산출.
    pub fn run(&mut self, program: &Json, args: Json) -> Result<Val, String> {
        let scope = Scope::root();
        scope.declare("args", json_to_val(&args));
        // 함수 선언 호이스팅.
        let body = program.get("body").and_then(|b| b.as_array()).cloned().unwrap_or_default();
        for stmt in &body {
            if stmt.get("type").and_then(|t| t.as_str()) == Some("FunctionDeclaration") {
                self.declare_function(stmt, &scope);
            }
        }
        for stmt in &body {
            if let Flow::Return(v) = self.exec_stmt(stmt, &scope)? {
                return Ok(v);
            }
        }
        Ok(Val::Undefined)
    }

    fn declare_function(&mut self, node: &Json, scope: &Scope) {
        if let Some(id) = node.get("id").and_then(|i| i.get("name")).and_then(|n| n.as_str()) {
            let f = self.make_closure(node, scope);
            scope.declare(id, f);
        }
    }

    fn make_closure(&self, node: &Json, scope: &Scope) -> Val {
        let params = node
            .get("params")
            .and_then(|p| p.as_array())
            .map(|ps| ps.iter().filter_map(|p| p.get("name").and_then(|n| n.as_str()).map(String::from)).collect())
            .unwrap_or_default();
        let body = node.get("body").cloned().unwrap_or(Json::Null);
        let is_block = body.get("type").and_then(|t| t.as_str()) == Some("BlockStatement");
        Val::Func(Rc::new(Closure { params, body, is_block, scope: scope.clone() }))
    }

    fn exec_stmt(&mut self, node: &Json, scope: &Scope) -> Result<Flow, String> {
        let ty = node.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match ty {
            "VariableDeclaration" => {
                for d in node.get("declarations").and_then(|a| a.as_array()).into_iter().flatten() {
                    let name = d.get("id").and_then(|i| i.get("name")).and_then(|n| n.as_str());
                    let init = d.get("init");
                    let v = match init {
                        Some(e) if !e.is_null() => self.eval(e, scope)?,
                        _ => Val::Undefined,
                    };
                    if let Some(name) = name {
                        scope.declare(name, v);
                    } else if let Some(id) = d.get("id") {
                        // 디스트럭처링(객체/배열) — 최소 지원.
                        self.bind_pattern(id, &v, scope);
                    }
                }
                Ok(Flow::Normal)
            }
            "FunctionDeclaration" => Ok(Flow::Normal), // 호이스팅 처리됨
            "ExpressionStatement" => {
                self.eval(node.get("expression").unwrap_or(&Json::Null), scope)?;
                Ok(Flow::Normal)
            }
            "ReturnStatement" => {
                let v = match node.get("argument") {
                    Some(e) if !e.is_null() => self.eval(e, scope)?,
                    _ => Val::Undefined,
                };
                Ok(Flow::Return(v))
            }
            "IfStatement" => {
                let test = self.eval(node.get("test").unwrap_or(&Json::Null), scope)?;
                if truthy(&test) {
                    self.exec_stmt(node.get("consequent").unwrap_or(&Json::Null), scope)
                } else if let Some(alt) = node.get("alternate").filter(|a| !a.is_null()) {
                    self.exec_stmt(alt, scope)
                } else {
                    Ok(Flow::Normal)
                }
            }
            "BlockStatement" => {
                let inner = scope.child();
                // 블록 내 함수 호이스팅.
                for stmt in node.get("body").and_then(|b| b.as_array()).into_iter().flatten() {
                    if stmt.get("type").and_then(|t| t.as_str()) == Some("FunctionDeclaration") {
                        self.declare_function(stmt, &inner);
                    }
                }
                for stmt in node.get("body").and_then(|b| b.as_array()).into_iter().flatten() {
                    if let Flow::Return(v) = self.exec_stmt(stmt, &inner)? {
                        return Ok(Flow::Return(v));
                    }
                }
                Ok(Flow::Normal)
            }
            "ForOfStatement" => {
                let iter = self.eval(node.get("right").unwrap_or(&Json::Null), scope)?;
                let items = as_array(&iter);
                let decl = node.get("left").unwrap_or(&Json::Null);
                let var = decl
                    .get("declarations")
                    .and_then(|a| a.as_array())
                    .and_then(|a| a.first())
                    .and_then(|d| d.get("id"))
                    .and_then(|i| i.get("name"))
                    .and_then(|n| n.as_str());
                for item in items {
                    let inner = scope.child();
                    if let Some(v) = var {
                        inner.declare(v, item);
                    }
                    if let Flow::Return(rv) = self.exec_stmt(node.get("body").unwrap_or(&Json::Null), &inner)? {
                        return Ok(Flow::Return(rv));
                    }
                }
                Ok(Flow::Normal)
            }
            "ExportNamedDeclaration" => {
                // export const meta = {...} 등 — 내부 선언 실행.
                match node.get("declaration").filter(|d| !d.is_null()) {
                    Some(decl) => self.exec_stmt(decl, scope),
                    None => Ok(Flow::Normal),
                }
            }
            "EmptyStatement" => Ok(Flow::Normal),
            "TryStatement" => {
                // try { } catch(e) { } — eager. block 실행, throw 시 catch.
                match self.exec_stmt(node.get("block").unwrap_or(&Json::Null), scope) {
                    Ok(f) => {
                        if let Some(fin) = node.get("finalizer").filter(|x| !x.is_null()) {
                            if let Flow::Return(v) = self.exec_stmt(fin, scope)? {
                                return Ok(Flow::Return(v));
                            }
                        }
                        Ok(f)
                    }
                    Err(e) => {
                        // 인터프리터 갭은 catch 가 삼키면 안 됨(꼼수 금지) — 진짜 throw 만 잡는다.
                        if is_interp_gap(&e) {
                            return Err(e);
                        }
                        if let Some(handler) = node.get("handler").filter(|h| !h.is_null()) {
                            let inner = scope.child();
                            if let Some(param) = handler.get("param").filter(|p| !p.is_null()) {
                                self.bind_pattern(param, &Val::Undefined, &inner);
                            }
                            let r = self.exec_stmt(handler.get("body").unwrap_or(&Json::Null), &inner);
                            if let Some(fin) = node.get("finalizer").filter(|x| !x.is_null()) {
                                let _ = self.exec_stmt(fin, scope);
                            }
                            return r;
                        }
                        Ok(Flow::Normal)
                    }
                }
            }
            "WhileStatement" => {
                let mut guard = 0u32;
                while truthy(&self.eval(node.get("test").unwrap_or(&Json::Null), scope)?) {
                    if let Flow::Return(v) = self.exec_stmt(node.get("body").unwrap_or(&Json::Null), scope)? {
                        return Ok(Flow::Return(v));
                    }
                    guard += 1;
                    if guard > 1_000_000 {
                        return Err("while 루프 1e6 초과(폭주 방지)".to_string());
                    }
                }
                Ok(Flow::Normal)
            }
            other => Err(format!("미지원 statement: {other}")),
        }
    }

    fn bind_pattern(&mut self, pat: &Json, v: &Val, scope: &Scope) {
        match pat.get("type").and_then(|t| t.as_str()) {
            Some("Identifier") => {
                if let Some(n) = pat.get("name").and_then(|n| n.as_str()) {
                    scope.declare(n, v.clone());
                }
            }
            Some("ObjectPattern") => {
                for p in pat.get("properties").and_then(|a| a.as_array()).into_iter().flatten() {
                    let key = p.get("key").and_then(|k| k.get("name")).and_then(|n| n.as_str());
                    if let Some(key) = key {
                        let val = member(v, key);
                        if let Some(vp) = p.get("value") {
                            self.bind_pattern(vp, &val, scope);
                        }
                    }
                }
            }
            Some("ArrayPattern") => {
                let arr = as_array(v);
                for (i, el) in pat.get("elements").and_then(|a| a.as_array()).into_iter().flatten().enumerate() {
                    if !el.is_null() {
                        let item = arr.get(i).cloned().unwrap_or(Val::Undefined);
                        self.bind_pattern(el, &item, scope);
                    }
                }
            }
            _ => {}
        }
    }

    fn eval(&mut self, node: &Json, scope: &Scope) -> Result<Val, String> {
        let ty = node.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match ty {
            "Literal" => Ok(json_to_val(node.get("value").unwrap_or(&Json::Null))),
            "Identifier" => {
                let name = node.get("name").and_then(|n| n.as_str()).unwrap_or("");
                if name == "undefined" {
                    return Ok(Val::Undefined);
                }
                if let Some(v) = scope.get(name) {
                    return Ok(v);
                }
                match name {
                    // 내장 전역(콜백 전달·값 사용 가능).
                    "Boolean" | "String" | "Number" | "parseInt" | "parseFloat" | "isNaN" | "isFinite" => {
                        Ok(Val::Native(name.to_string()))
                    }
                    "NaN" => Ok(Val::Num(f64::NAN)),
                    "Infinity" => Ok(Val::Num(f64::INFINITY)),
                    // 미정의 식별자 — JS 라면 ReferenceError. 갭으로 loud(누락 전역/오타 은폐 금지).
                    // typeof 만 예외(UnaryExpression 에서 이 갭을 잡아 "undefined" 반환).
                    _ => Err(format!("미정의 식별자 {name:?}")),
                }
            }
            "TemplateLiteral" => {
                let quasis = node.get("quasis").and_then(|q| q.as_array()).cloned().unwrap_or_default();
                let exprs = node.get("expressions").and_then(|e| e.as_array()).cloned().unwrap_or_default();
                let mut s = String::new();
                for (i, q) in quasis.iter().enumerate() {
                    let cooked = q.get("value").and_then(|v| v.get("cooked")).and_then(|c| c.as_str()).unwrap_or("");
                    s.push_str(cooked);
                    if i < exprs.len() {
                        let v = self.eval(&exprs[i], scope)?;
                        s.push_str(&to_string(&v));
                    }
                }
                Ok(Val::Str(s))
            }
            "ArrayExpression" => {
                let mut out = Vec::new();
                for el in node.get("elements").and_then(|a| a.as_array()).into_iter().flatten() {
                    if el.is_null() {
                        out.push(Val::Undefined);
                    } else if el.get("type").and_then(|t| t.as_str()) == Some("SpreadElement") {
                        let v = self.eval(el.get("argument").unwrap_or(&Json::Null), scope)?;
                        out.extend(as_array(&v));
                    } else {
                        out.push(self.eval(el, scope)?);
                    }
                }
                Ok(Val::Arr(Rc::new(RefCell::new(out))))
            }
            "ObjectExpression" => {
                let mut map = BTreeMap::new();
                for p in node.get("properties").and_then(|a| a.as_array()).into_iter().flatten() {
                    if p.get("type").and_then(|t| t.as_str()) == Some("SpreadElement") {
                        let v = self.eval(p.get("argument").unwrap_or(&Json::Null), scope)?;
                        if let Val::Obj(o) = v {
                            for (k, vv) in o.borrow().iter() {
                                map.insert(k.clone(), vv.clone());
                            }
                        }
                        continue;
                    }
                    let key = self.prop_key(p, scope)?;
                    let val = self.eval(p.get("value").unwrap_or(&Json::Null), scope)?;
                    map.insert(key, val);
                }
                Ok(Val::Obj(Rc::new(RefCell::new(map))))
            }
            "ArrowFunctionExpression" | "FunctionExpression" => Ok(self.make_closure(node, scope)),
            "AwaitExpression" => self.eval(node.get("argument").unwrap_or(&Json::Null), scope), // eager: 이미 해소됨
            "UnaryExpression" => {
                let op = node.get("operator").and_then(|o| o.as_str()).unwrap_or("");
                let arg_node = node.get("argument").unwrap_or(&Json::Null);
                // typeof 미선언 식별자 → "undefined"(JS: ReferenceError 안 남). 갭만 흡수, 그 외 전파.
                if op == "typeof" {
                    return match self.eval(arg_node, scope) {
                        Ok(v) => Ok(Val::Str(type_of(&v).to_string())),
                        Err(e) if e.starts_with("미정의 식별자") => Ok(Val::Str("undefined".to_string())),
                        Err(e) => Err(e),
                    };
                }
                let arg = self.eval(arg_node, scope)?;
                Ok(match op {
                    "!" => Val::Bool(!truthy(&arg)),
                    "-" => Val::Num(-to_num(&arg)),
                    "+" => Val::Num(to_num(&arg)),
                    "void" => Val::Undefined,
                    _ => return Err(format!("미지원 단항 연산자: {op}")),
                })
            }
            "BinaryExpression" => {
                let l = self.eval(node.get("left").unwrap_or(&Json::Null), scope)?;
                let r = self.eval(node.get("right").unwrap_or(&Json::Null), scope)?;
                Ok(binop(node.get("operator").and_then(|o| o.as_str()).unwrap_or(""), &l, &r))
            }
            "LogicalExpression" => {
                let l = self.eval(node.get("left").unwrap_or(&Json::Null), scope)?;
                let op = node.get("operator").and_then(|o| o.as_str()).unwrap_or("");
                match op {
                    "&&" => {
                        if truthy(&l) {
                            self.eval(node.get("right").unwrap_or(&Json::Null), scope)
                        } else {
                            Ok(l)
                        }
                    }
                    "||" => {
                        if truthy(&l) {
                            Ok(l)
                        } else {
                            self.eval(node.get("right").unwrap_or(&Json::Null), scope)
                        }
                    }
                    "??" => {
                        if matches!(l, Val::Null | Val::Undefined) {
                            self.eval(node.get("right").unwrap_or(&Json::Null), scope)
                        } else {
                            Ok(l)
                        }
                    }
                    _ => Ok(Val::Undefined),
                }
            }
            "ConditionalExpression" => {
                let t = self.eval(node.get("test").unwrap_or(&Json::Null), scope)?;
                if truthy(&t) {
                    self.eval(node.get("consequent").unwrap_or(&Json::Null), scope)
                } else {
                    self.eval(node.get("alternate").unwrap_or(&Json::Null), scope)
                }
            }
            "AssignmentExpression" => {
                let target = node.get("left").unwrap_or(&Json::Null);
                let op = node.get("operator").and_then(|o| o.as_str()).unwrap_or("=");
                let rhs = self.eval(node.get("right").unwrap_or(&Json::Null), scope)?;
                // 복합대입(+=, -= 등)은 현재값과 결합.
                let val = if op == "=" {
                    rhs
                } else {
                    let cur = self.eval(target, scope)?;
                    binop(&op[..op.len() - 1], &cur, &rhs)
                };
                self.assign(target, val.clone(), scope)?;
                Ok(val)
            }
            "UpdateExpression" => {
                // x++ / x-- / ++x / --x — Identifier·MemberExpression 대상.
                let target = node.get("argument").unwrap_or(&Json::Null);
                let prefix = node.get("prefix").and_then(|p| p.as_bool()).unwrap_or(false);
                let op = node.get("operator").and_then(|o| o.as_str()).unwrap_or("++");
                let old = to_num(&self.eval(target, scope)?);
                let new = if op == "++" { old + 1.0 } else { old - 1.0 };
                self.assign(target, Val::Num(new), scope)?;
                Ok(Val::Num(if prefix { new } else { old }))
            }
            "MemberExpression" => {
                let obj = self.eval(node.get("object").unwrap_or(&Json::Null), scope)?;
                let key = self.member_key(node, scope)?;
                Ok(member(&obj, &key))
            }
            "CallExpression" => self.eval_call(node, scope),
            "SequenceExpression" => {
                let mut last = Val::Undefined;
                for e in node.get("expressions").and_then(|a| a.as_array()).into_iter().flatten() {
                    last = self.eval(e, scope)?;
                }
                Ok(last)
            }
            "NewExpression" => self.eval_new(node, scope),
            "RegExpLiteral" => Ok(Val::Undefined), // 정규식 객체(미니멀) — replace/match 에서 패턴 사용
            "SpreadElement" => self.eval(node.get("argument").unwrap_or(&Json::Null), scope),
            other => Err(format!("미지원 expression: {other}")),
        }
    }

    /// new X(...) — Map/Set/URL 최소 지원(deep-research 등).
    fn eval_new(&mut self, node: &Json, scope: &Scope) -> Result<Val, String> {
        let callee = node.get("callee").and_then(|c| c.get("name")).and_then(|n| n.as_str()).unwrap_or("");
        let mut args = Vec::new();
        for a in node.get("arguments").and_then(|a| a.as_array()).into_iter().flatten() {
            args.push(self.eval(a, scope)?);
        }
        match callee {
            // Map/Set 은 객체로 모사: __kind 표시 + entries. 최소 — get/set/has/add 는 call_method 처리.
            "Map" => {
                let mut m = BTreeMap::new();
                m.insert("__map".to_string(), Val::Obj(Rc::new(RefCell::new(BTreeMap::new()))));
                Ok(Val::Obj(Rc::new(RefCell::new(m))))
            }
            "Set" => {
                let mut m = BTreeMap::new();
                m.insert("__set".to_string(), Val::Obj(Rc::new(RefCell::new(BTreeMap::new()))));
                Ok(Val::Obj(Rc::new(RefCell::new(m))))
            }
            "URL" => {
                // new URL(u) — 최소: href/hostname/pathname 을 입력 그대로/근사. catch 로 보호되는 용도.
                let u = args.first().map(to_string).unwrap_or_default();
                let mut m = BTreeMap::new();
                m.insert("href".to_string(), Val::Str(u.clone()));
                m.insert("hostname".to_string(), Val::Str(u.clone()));
                m.insert("pathname".to_string(), Val::Str(String::new()));
                Ok(Val::Obj(Rc::new(RefCell::new(m))))
            }
            other => Err(format!("미지원 new {other}")),
        }
    }

    fn prop_key(&mut self, p: &Json, scope: &Scope) -> Result<String, String> {
        let key = p.get("key").unwrap_or(&Json::Null);
        if p.get("computed").and_then(|c| c.as_bool()).unwrap_or(false) {
            Ok(to_string(&self.eval(key, scope)?))
        } else if let Some(n) = key.get("name").and_then(|n| n.as_str()) {
            Ok(n.to_string())
        } else if let Some(v) = key.get("value") {
            Ok(to_string(&json_to_val(v)))
        } else {
            Ok(String::new())
        }
    }

    fn member_key(&mut self, node: &Json, scope: &Scope) -> Result<String, String> {
        let prop = node.get("property").unwrap_or(&Json::Null);
        if node.get("computed").and_then(|c| c.as_bool()).unwrap_or(false) {
            Ok(to_string(&self.eval(prop, scope)?))
        } else {
            Ok(prop.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string())
        }
    }

    fn assign(&mut self, target: &Json, val: Val, scope: &Scope) -> Result<(), String> {
        match target.get("type").and_then(|t| t.as_str()) {
            Some("Identifier") => {
                let n = target.get("name").and_then(|n| n.as_str()).unwrap_or("");
                scope.set(n, val);
                Ok(())
            }
            Some("MemberExpression") => {
                let obj = self.eval(target.get("object").unwrap_or(&Json::Null), scope)?;
                let key = self.member_key(target, scope)?;
                match obj {
                    Val::Obj(o) => {
                        o.borrow_mut().insert(key, val);
                    }
                    Val::Arr(a) => {
                        if let Ok(i) = key.parse::<usize>() {
                            let mut b = a.borrow_mut();
                            while b.len() <= i {
                                b.push(Val::Undefined);
                            }
                            b[i] = val;
                        }
                    }
                    _ => {}
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }

    fn eval_call(&mut self, node: &Json, scope: &Scope) -> Result<Val, String> {
        let callee = node.get("callee").unwrap_or(&Json::Null);
        // 인자 평가(spread 포함).
        let mut args: Vec<Val> = Vec::new();
        for a in node.get("arguments").and_then(|a| a.as_array()).into_iter().flatten() {
            if a.get("type").and_then(|t| t.as_str()) == Some("SpreadElement") {
                let v = self.eval(a.get("argument").unwrap_or(&Json::Null), scope)?;
                args.extend(as_array(&v));
            } else {
                args.push(self.eval(a, scope)?);
            }
        }

        // 메서드 호출 / 전역 호출 구분.
        if callee.get("type").and_then(|t| t.as_str()) == Some("MemberExpression") {
            let obj_node = callee.get("object").unwrap_or(&Json::Null);
            let method = self.member_key(callee, scope)?;
            // JSON.stringify / Object.values / Array.isArray / Promise.all / console.log 등 정적 네임스페이스.
            if let Some(name) = obj_node.get("name").and_then(|n| n.as_str()) {
                match (name, method.as_str()) {
                    ("JSON", "stringify") => return Ok(Val::Str(json_stringify(args.first().unwrap_or(&Val::Undefined)))),
                    ("JSON", "parse") => {
                        let s = args.first().map(to_string).unwrap_or_default();
                        return Ok(serde_json::from_str::<Json>(&s).map(|j| json_to_val(&j)).unwrap_or(Val::Undefined));
                    }
                    ("Object", "values") => return Ok(object_values(args.first().unwrap_or(&Val::Undefined))),
                    ("Object", "keys") => return Ok(object_keys(args.first().unwrap_or(&Val::Undefined))),
                    ("Object", "entries") => return Ok(object_entries(args.first().unwrap_or(&Val::Undefined))),
                    ("Array", "isArray") => return Ok(Val::Bool(matches!(args.first(), Some(Val::Arr(_))))),
                    ("Array", "from") => {
                        // Array.from(arrayLike, mapFn?) — Arr 또는 {length:n}. mapFn(el, i).
                        let src = args.first().cloned().unwrap_or(Val::Undefined);
                        let map_fn = args.get(1).cloned();
                        let base: Vec<Val> = match &src {
                            Val::Arr(a) => a.borrow().clone(),
                            Val::Obj(o) => {
                                let n = to_num(&member(&Val::Obj(o.clone()), "length")).max(0.0) as usize;
                                vec![Val::Undefined; n]
                            }
                            _ => vec![],
                        };
                        let mut out = Vec::with_capacity(base.len());
                        for (i, el) in base.into_iter().enumerate() {
                            let v = match &map_fn {
                                Some(f) => self.call_value(f, vec![el, Val::Num(i as f64)], scope)?,
                                None => el,
                            };
                            out.push(v);
                        }
                        return Ok(Val::Arr(Rc::new(RefCell::new(out))));
                    }
                    ("Object", "assign") => {
                        // Object.assign(target, ...sources) — target 에 병합.
                        let target = args.first().cloned().unwrap_or(Val::Undefined);
                        if let Val::Obj(t) = &target {
                            for src in args.iter().skip(1) {
                                if let Val::Obj(s) = src {
                                    for (k, v) in s.borrow().iter() {
                                        t.borrow_mut().insert(k.clone(), v.clone());
                                    }
                                }
                            }
                        }
                        return Ok(target);
                    }
                    ("Math", "max") => return Ok(Val::Num(args.iter().map(to_num).fold(f64::NEG_INFINITY, f64::max))),
                    ("Math", "min") => return Ok(Val::Num(args.iter().map(to_num).fold(f64::INFINITY, f64::min))),
                    ("Math", "floor") => return Ok(Val::Num(to_num(args.first().unwrap_or(&Val::Undefined)).floor())),
                    ("Math", "ceil") => return Ok(Val::Num(to_num(args.first().unwrap_or(&Val::Undefined)).ceil())),
                    ("Math", "round") => return Ok(Val::Num(to_num(args.first().unwrap_or(&Val::Undefined)).round())),
                    ("Math", "abs") => return Ok(Val::Num(to_num(args.first().unwrap_or(&Val::Undefined)).abs())),
                    ("Promise", "all") => {
                        // eager: 인자 배열(이미 해소됨)을 그대로.
                        return Ok(args.into_iter().next().unwrap_or(Val::Undefined));
                    }
                    ("console", "log") | ("console", "error") => {
                        return Ok(Val::Undefined);
                    }
                    _ => {}
                }
            }
            let obj = self.eval(obj_node, scope)?;
            return self.call_method(&obj, &method, args, scope);
        }

        // 전역 식별자 호출.
        if let Some(name) = callee.get("name").and_then(|n| n.as_str()) {
            match name {
                "agent" => {
                    let prompt = to_string(args.first().unwrap_or(&Val::Undefined));
                    let opts = match args.get(1) {
                        Some(Val::Obj(o)) => o.borrow().clone(),
                        _ => BTreeMap::new(),
                    };
                    return self.host.agent(&prompt, &opts);
                }
                "phase" => {
                    self.host.phase(&to_string(args.first().unwrap_or(&Val::Undefined)));
                    return Ok(Val::Undefined);
                }
                "log" => {
                    self.host.log(&to_string(args.first().unwrap_or(&Val::Undefined)));
                    return Ok(Val::Undefined);
                }
                "parallel" => return self.run_parallel(args, scope),
                "pipeline" => return self.run_pipeline(args, scope),
                _ => {
                    if let Some(f) = scope.get(name) {
                        return self.call_value(&f, args, scope);
                    }
                    return Err(format!("미정의 함수 {name:?}"));
                }
            }
        }

        // 그 외(즉시호출 등): callee 평가 → 호출.
        let f = self.eval(callee, scope)?;
        self.call_value(&f, args, scope)
    }

    /// parallel(thunks) — barrier. 각 thunk 호출(클로저), 결과 배열(throw→null). engine 계약.
    fn run_parallel(&mut self, args: Vec<Val>, scope: &Scope) -> Result<Val, String> {
        let thunks = match args.into_iter().next() {
            Some(v) => as_array(&v),
            None => vec![],
        };
        let mut out = Vec::with_capacity(thunks.len());
        // 동시 그룹: 안의 agent 노드들은 서로 blockedBy 없음(형제).
        self.host.group_enter("parallel");
        for t in thunks {
            match self.call_value(&t, vec![], scope) {
                Ok(v) => out.push(v),
                // 인터프리터 갭은 전파(loud). 진짜 throw 만 null(engine 계약: thunk throw→null).
                Err(e) => {
                    if is_interp_gap(&e) {
                        self.host.group_exit();
                        return Err(e);
                    }
                    out.push(Val::Null);
                }
            }
        }
        self.host.group_exit();
        Ok(Val::Arr(Rc::new(RefCell::new(out))))
    }

    /// pipeline(items, ...stages) — no-barrier. 각 item 을 stage 순차 통과(eager: 순서대로). engine 계약.
    fn run_pipeline(&mut self, mut args: Vec<Val>, scope: &Scope) -> Result<Val, String> {
        if args.is_empty() {
            return Ok(Val::Arr(Rc::new(RefCell::new(vec![]))));
        }
        let items = as_array(&args.remove(0));
        let stages = args; // 나머지 = stage 콜백들
        let mut out = Vec::with_capacity(items.len());
        // 순차 그룹: 각 item 은 독립 stage 체인(같은 item 내 stage 간 blockedBy 체인).
        self.host.group_enter("pipeline");
        for (idx, item) in items.into_iter().enumerate() {
            let mut prev = item.clone();
            let mut dropped = false;
            self.host.stage_boundary(); // 새 item 체인 시작(체인 리셋).
            for st in &stages {
                match self.call_value(st, vec![prev.clone(), item.clone(), Val::Num(idx as f64)], scope) {
                    Ok(v) => prev = v,
                    // 인터프리터 갭은 전파(loud). 진짜 throw 만 item→null 드롭(engine 계약).
                    Err(e) => {
                        if is_interp_gap(&e) {
                            self.host.group_exit();
                            return Err(e);
                        }
                        dropped = true;
                        break;
                    }
                }
            }
            out.push(if dropped { Val::Null } else { prev });
        }
        self.host.group_exit();
        Ok(Val::Arr(Rc::new(RefCell::new(out))))
    }

    fn call_value(&mut self, f: &Val, args: Vec<Val>, _caller: &Scope) -> Result<Val, String> {
        if let Val::Native(name) = f {
            let a0 = args.first().cloned().unwrap_or(Val::Undefined);
            return Ok(match name.as_str() {
                "Boolean" => Val::Bool(truthy(&a0)),
                "String" => Val::Str(to_string(&a0)),
                "Number" => Val::Num(to_num(&a0)),
                "parseInt" => {
                    let s = to_string(&a0);
                    let radix = args.get(1).map(to_num).filter(|r| *r >= 2.0).map(|r| r as u32).unwrap_or(10);
                    let t = s.trim();
                    let (neg, digits) = t.strip_prefix('-').map(|d| (true, d)).unwrap_or((false, t.strip_prefix('+').unwrap_or(t)));
                    let take: String = digits.chars().take_while(|c| c.is_digit(radix)).collect();
                    match i64::from_str_radix(&take, radix) {
                        Ok(n) => Val::Num(if neg { -(n as f64) } else { n as f64 }),
                        Err(_) => Val::Num(f64::NAN),
                    }
                }
                "parseFloat" => {
                    let s = to_string(&a0);
                    let t = s.trim();
                    // 선두 숫자 토큰만.
                    let end = t.find(|c: char| !(c.is_ascii_digit() || matches!(c, '.' | '-' | '+' | 'e' | 'E'))).unwrap_or(t.len());
                    Val::Num(t[..end].parse::<f64>().unwrap_or(f64::NAN))
                }
                "isNaN" => Val::Bool(to_num(&a0).is_nan()),
                "isFinite" => Val::Bool(to_num(&a0).is_finite()),
                _ => return Err(format!("미지원 내장 호출: {name}")),
            });
        }
        let cl = match f {
            Val::Func(c) => c.clone(),
            _ => return Err("호출 대상이 함수가 아님".to_string()),
        };
        let inner = cl.scope.child();
        for (i, p) in cl.params.iter().enumerate() {
            inner.declare(p, args.get(i).cloned().unwrap_or(Val::Undefined));
        }
        if cl.is_block {
            // 함수 본문 호이스팅.
            for stmt in cl.body.get("body").and_then(|b| b.as_array()).into_iter().flatten() {
                if stmt.get("type").and_then(|t| t.as_str()) == Some("FunctionDeclaration") {
                    self.declare_function(stmt, &inner);
                }
            }
            for stmt in cl.body.get("body").and_then(|b| b.as_array()).into_iter().flatten() {
                if let Flow::Return(v) = self.exec_stmt(stmt, &inner)? {
                    return Ok(v);
                }
            }
            Ok(Val::Undefined)
        } else {
            // arrow 단문: body 가 expression.
            self.eval(&cl.body, &inner)
        }
    }

    fn call_method(&mut self, obj: &Val, method: &str, args: Vec<Val>, scope: &Scope) -> Result<Val, String> {
        // Promise 메서드(then/catch/finally)는 어떤 값에도 올 수 있음(parallel→Arr, agent→Obj, 실패→Null).
        if matches!(method, "then" | "catch" | "finally") {
            if let Some(r) = self.promise_method(obj, method, &args, scope)? {
                return Ok(r);
            }
        }
        match obj {
            Val::Arr(a) => self.array_method(a, method, args, scope),
            Val::Str(s) => string_method(s, method, &args),
            Val::Obj(o) => {
                let (is_map, is_set) = {
                    let b = o.borrow();
                    (b.contains_key("__map"), b.contains_key("__set"))
                };
                if is_map {
                    return self.map_method(o, method, args);
                }
                if is_set {
                    return self.set_method(o, method, args);
                }
                // Promise 메서드(eager): then→cb(obj), catch→통과(거부 없음), finally→cb() 후 통과.
                if let Some(r) = self.promise_method(obj, method, &args, scope)? {
                    return Ok(r);
                }
                Err(format!("미지원 객체 메서드: {method}"))
            }
            _ => {
                // null/undefined 의 Promise 메서드 — eager null/값 전파(agent 실패 시 null.then 등).
                if let Some(r) = self.promise_method(obj, method, &args, scope)? {
                    return Ok(r);
                }
                // null/undefined 의 다른 메서드 — JS 라면 TypeError. eager 모델에서 undefined.
                Ok(Val::Undefined)
            }
        }
    }

    fn map_method(&mut self, o: &Rc<RefCell<BTreeMap<String, Val>>>, method: &str, args: Vec<Val>) -> Result<Val, String> {
        let inner = match o.borrow().get("__map") {
            Some(Val::Obj(m)) => m.clone(),
            _ => return Err("Map 내부 손상".to_string()),
        };
        let key = args.first().map(to_string).unwrap_or_default();
        match method {
            "set" => {
                inner.borrow_mut().insert(key, args.get(1).cloned().unwrap_or(Val::Undefined));
                Ok(Val::Obj(o.clone()))
            }
            "get" => Ok(inner.borrow().get(&key).cloned().unwrap_or(Val::Undefined)),
            "has" => Ok(Val::Bool(inner.borrow().contains_key(&key))),
            "delete" => Ok(Val::Bool(inner.borrow_mut().remove(&key).is_some())),
            "keys" | "values" => {
                let vals: Vec<Val> = if method == "keys" {
                    inner.borrow().keys().map(|k| Val::Str(k.clone())).collect()
                } else {
                    inner.borrow().values().cloned().collect()
                };
                Ok(Val::Arr(Rc::new(RefCell::new(vals))))
            }
            other => Err(format!("미지원 Map 메서드: {other}")),
        }
    }

    fn set_method(&mut self, o: &Rc<RefCell<BTreeMap<String, Val>>>, method: &str, args: Vec<Val>) -> Result<Val, String> {
        let inner = match o.borrow().get("__set") {
            Some(Val::Obj(m)) => m.clone(),
            _ => return Err("Set 내부 손상".to_string()),
        };
        let key = args.first().map(to_string).unwrap_or_default();
        match method {
            "add" => {
                inner.borrow_mut().insert(key, Val::Bool(true));
                Ok(Val::Obj(o.clone()))
            }
            "has" => Ok(Val::Bool(inner.borrow().contains_key(&key))),
            "delete" => Ok(Val::Bool(inner.borrow_mut().remove(&key).is_some())),
            other => Err(format!("미지원 Set 메서드: {other}")),
        }
    }

    /// Promise 메서드(eager 모델). then→cb(value), catch→통과(eager 는 거부 없음), finally→cb() 후 통과.
    /// 해당 없으면 None.
    fn promise_method(&mut self, recv: &Val, method: &str, args: &[Val], scope: &Scope) -> Result<Option<Val>, String> {
        match method {
            "then" => {
                if let Some(cb) = args.first() {
                    Ok(Some(self.call_value(cb, vec![recv.clone()], scope)?))
                } else {
                    Ok(Some(Val::Undefined))
                }
            }
            // eager: 값은 이미 해소(거부 없음) → catch 콜백 무시, receiver 그대로.
            "catch" => Ok(Some(recv.clone())),
            "finally" => {
                if let Some(cb) = args.first() {
                    self.call_value(cb, vec![], scope)?;
                }
                Ok(Some(recv.clone()))
            }
            _ => Ok(None),
        }
    }

    fn array_method(&mut self, a: &Rc<RefCell<Vec<Val>>>, method: &str, args: Vec<Val>, scope: &Scope) -> Result<Val, String> {
        match method {
            "map" => {
                let cb = args.first().cloned().unwrap_or(Val::Undefined);
                let items: Vec<Val> = a.borrow().clone();
                let mut out = Vec::with_capacity(items.len());
                for (i, it) in items.into_iter().enumerate() {
                    out.push(self.call_value(&cb, vec![it, Val::Num(i as f64)], scope)?);
                }
                Ok(Val::Arr(Rc::new(RefCell::new(out))))
            }
            "filter" => {
                let cb = args.first().cloned().unwrap_or(Val::Undefined);
                let items: Vec<Val> = a.borrow().clone();
                let mut out = Vec::new();
                for (i, it) in items.into_iter().enumerate() {
                    if truthy(&self.call_value(&cb, vec![it.clone(), Val::Num(i as f64)], scope)?) {
                        out.push(it);
                    }
                }
                Ok(Val::Arr(Rc::new(RefCell::new(out))))
            }
            "forEach" => {
                let cb = args.first().cloned().unwrap_or(Val::Undefined);
                let items: Vec<Val> = a.borrow().clone();
                for (i, it) in items.into_iter().enumerate() {
                    self.call_value(&cb, vec![it, Val::Num(i as f64)], scope)?;
                }
                Ok(Val::Undefined)
            }
            "some" => {
                let cb = args.first().cloned().unwrap_or(Val::Undefined);
                let items: Vec<Val> = a.borrow().clone();
                for (i, it) in items.into_iter().enumerate() {
                    if truthy(&self.call_value(&cb, vec![it, Val::Num(i as f64)], scope)?) {
                        return Ok(Val::Bool(true));
                    }
                }
                Ok(Val::Bool(false))
            }
            "every" => {
                let cb = args.first().cloned().unwrap_or(Val::Undefined);
                let items: Vec<Val> = a.borrow().clone();
                for (i, it) in items.into_iter().enumerate() {
                    if !truthy(&self.call_value(&cb, vec![it, Val::Num(i as f64)], scope)?) {
                        return Ok(Val::Bool(false));
                    }
                }
                Ok(Val::Bool(true))
            }
            "find" => {
                let cb = args.first().cloned().unwrap_or(Val::Undefined);
                let items: Vec<Val> = a.borrow().clone();
                for (i, it) in items.into_iter().enumerate() {
                    if truthy(&self.call_value(&cb, vec![it.clone(), Val::Num(i as f64)], scope)?) {
                        return Ok(it);
                    }
                }
                Ok(Val::Undefined)
            }
            "push" => {
                let mut b = a.borrow_mut();
                for v in args {
                    b.push(v);
                }
                Ok(Val::Num(b.len() as f64))
            }
            "join" => {
                let sep = args.first().map(to_string).unwrap_or_else(|| ",".to_string());
                let parts: Vec<String> = a.borrow().iter().map(to_string).collect();
                Ok(Val::Str(parts.join(&sep)))
            }
            "slice" => {
                let b = a.borrow();
                let start = args.first().map(|v| to_num(v) as usize).unwrap_or(0).min(b.len());
                let end = args.get(1).map(|v| to_num(v) as usize).unwrap_or(b.len()).min(b.len());
                Ok(Val::Arr(Rc::new(RefCell::new(b[start..end.max(start)].to_vec()))))
            }
            "concat" => {
                let mut out = a.borrow().clone();
                for v in args {
                    out.extend(as_array(&v));
                }
                Ok(Val::Arr(Rc::new(RefCell::new(out))))
            }
            "flat" => {
                let mut out = Vec::new();
                for v in a.borrow().iter() {
                    match v {
                        Val::Arr(inner) => out.extend(inner.borrow().iter().cloned()),
                        other => out.push(other.clone()),
                    }
                }
                Ok(Val::Arr(Rc::new(RefCell::new(out))))
            }
            "flatMap" => {
                let cb = args.first().cloned().unwrap_or(Val::Undefined);
                let items: Vec<Val> = a.borrow().clone();
                let mut out = Vec::new();
                for (i, it) in items.into_iter().enumerate() {
                    let r = self.call_value(&cb, vec![it, Val::Num(i as f64)], scope)?;
                    match r {
                        Val::Arr(inner) => out.extend(inner.borrow().iter().cloned()),
                        other => out.push(other),
                    }
                }
                Ok(Val::Arr(Rc::new(RefCell::new(out))))
            }
            "reduce" => {
                let cb = args.first().cloned().unwrap_or(Val::Undefined);
                let items: Vec<Val> = a.borrow().clone();
                let (mut acc, start) = match args.get(1) {
                    Some(init) => (init.clone(), 0),
                    None => (items.first().cloned().unwrap_or(Val::Undefined), 1),
                };
                for (i, it) in items.iter().enumerate().skip(start) {
                    acc = self.call_value(&cb, vec![acc, it.clone(), Val::Num(i as f64)], scope)?;
                }
                Ok(acc)
            }
            "sort" => {
                // 비교자 기반 안정 정렬(삽입). self 호출 위해 sort_by 대신 수동.
                let cb = args.first().cloned();
                let mut items: Vec<Val> = a.borrow().clone();
                let n = items.len();
                for i in 1..n {
                    let mut j = i;
                    while j > 0 {
                        let c = match &cb {
                            Some(f) => to_num(&self.call_value(f, vec![items[j - 1].clone(), items[j].clone()], scope)?),
                            None => {
                                if to_string(&items[j - 1]) > to_string(&items[j]) {
                                    1.0
                                } else {
                                    -1.0
                                }
                            }
                        };
                        if c > 0.0 {
                            items.swap(j - 1, j);
                            j -= 1;
                        } else {
                            break;
                        }
                    }
                }
                *a.borrow_mut() = items;
                Ok(Val::Arr(a.clone()))
            }
            "reverse" => {
                a.borrow_mut().reverse();
                Ok(Val::Arr(a.clone()))
            }
            "indexOf" => {
                let needle = args.first().cloned().unwrap_or(Val::Undefined);
                let idx = a.borrow().iter().position(|x| strict_eq(x, &needle));
                Ok(Val::Num(idx.map(|i| i as f64).unwrap_or(-1.0)))
            }
            "includes" => {
                let needle = args.first().cloned().unwrap_or(Val::Undefined);
                Ok(Val::Bool(a.borrow().iter().any(|x| strict_eq(x, &needle))))
            }
            "findIndex" => {
                let cb = args.first().cloned().unwrap_or(Val::Undefined);
                let items: Vec<Val> = a.borrow().clone();
                for (i, it) in items.into_iter().enumerate() {
                    if truthy(&self.call_value(&cb, vec![it, Val::Num(i as f64)], scope)?) {
                        return Ok(Val::Num(i as f64));
                    }
                }
                Ok(Val::Num(-1.0))
            }
            "shift" => {
                let mut b = a.borrow_mut();
                if b.is_empty() {
                    Ok(Val::Undefined)
                } else {
                    Ok(b.remove(0))
                }
            }
            "pop" => Ok(a.borrow_mut().pop().unwrap_or(Val::Undefined)),
            "at" => {
                let b = a.borrow();
                let i = to_num(args.first().unwrap_or(&Val::Undefined));
                let idx = if i < 0.0 { b.len() as f64 + i } else { i } as usize;
                Ok(b.get(idx).cloned().unwrap_or(Val::Undefined))
            }
            other => Err(format!("미지원 배열 메서드: {other}")),
        }
    }
}

// ── 값 헬퍼 ──
fn truthy(v: &Val) -> bool {
    match v {
        Val::Undefined | Val::Null => false,
        Val::Bool(b) => *b,
        Val::Num(n) => *n != 0.0 && !n.is_nan(),
        Val::Str(s) => !s.is_empty(),
        _ => true,
    }
}
fn to_num(v: &Val) -> f64 {
    match v {
        Val::Num(n) => *n,
        Val::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Val::Str(s) => s.trim().parse().unwrap_or(f64::NAN),
        Val::Null => 0.0,
        _ => f64::NAN,
    }
}
pub fn to_string(v: &Val) -> String {
    match v {
        Val::Undefined => "undefined".to_string(),
        Val::Null => "null".to_string(),
        Val::Bool(b) => b.to_string(),
        Val::Num(n) => {
            if n.fract() == 0.0 && n.is_finite() {
                format!("{}", *n as i64)
            } else {
                format!("{n}")
            }
        }
        Val::Str(s) => s.clone(),
        Val::Arr(_) | Val::Obj(_) => json_stringify(v),
        Val::Func(_) | Val::Native(_) => "[function]".to_string(),
    }
}
fn type_of(v: &Val) -> &'static str {
    match v {
        Val::Undefined => "undefined",
        Val::Null => "object",
        Val::Bool(_) => "boolean",
        Val::Num(_) => "number",
        Val::Str(_) => "string",
        Val::Func(_) | Val::Native(_) => "function",
        _ => "object",
    }
}
fn as_array(v: &Val) -> Vec<Val> {
    match v {
        Val::Arr(a) => a.borrow().clone(),
        _ => vec![],
    }
}
fn member(obj: &Val, key: &str) -> Val {
    match obj {
        Val::Obj(o) => {
            if key == "size" {
                let b = o.borrow();
                if let Some(Val::Obj(m)) = b.get("__map").or_else(|| b.get("__set")) {
                    return Val::Num(m.borrow().len() as f64);
                }
            }
            o.borrow().get(key).cloned().unwrap_or(Val::Undefined)
        }
        Val::Arr(a) => {
            if key == "length" {
                Val::Num(a.borrow().len() as f64)
            } else if let Ok(i) = key.parse::<usize>() {
                a.borrow().get(i).cloned().unwrap_or(Val::Undefined)
            } else {
                Val::Undefined
            }
        }
        Val::Str(s) => {
            if key == "length" {
                Val::Num(s.chars().count() as f64)
            } else {
                Val::Undefined
            }
        }
        _ => Val::Undefined,
    }
}
/// 인터프리터 미지원(갭) 에러인가 — 진짜 JS throw 와 구분. 갭은 어디서도 삼키지 않고 전파(꼼수 금지).
fn is_interp_gap(e: &str) -> bool {
    e.starts_with("미지원") || e.starts_with("미정의") || e.starts_with("호출 대상") || e.contains("내부 손상")
}
fn binop(op: &str, l: &Val, r: &Val) -> Val {
    match op {
        "+" => match (l, r) {
            (Val::Str(_), _) | (_, Val::Str(_)) => Val::Str(format!("{}{}", to_string(l), to_string(r))),
            _ => Val::Num(to_num(l) + to_num(r)),
        },
        "-" => Val::Num(to_num(l) - to_num(r)),
        "*" => Val::Num(to_num(l) * to_num(r)),
        "/" => Val::Num(to_num(l) / to_num(r)),
        "%" => Val::Num(to_num(l) % to_num(r)),
        "===" | "==" => Val::Bool(strict_eq(l, r)),
        "!==" | "!=" => Val::Bool(!strict_eq(l, r)),
        "<" => Val::Bool(to_num(l) < to_num(r)),
        ">" => Val::Bool(to_num(l) > to_num(r)),
        "<=" => Val::Bool(to_num(l) <= to_num(r)),
        ">=" => Val::Bool(to_num(l) >= to_num(r)),
        _ => Val::Undefined,
    }
}
fn strict_eq(l: &Val, r: &Val) -> bool {
    match (l, r) {
        (Val::Undefined, Val::Undefined) | (Val::Null, Val::Null) => true,
        (Val::Bool(a), Val::Bool(b)) => a == b,
        (Val::Num(a), Val::Num(b)) => a == b,
        (Val::Str(a), Val::Str(b)) => a == b,
        _ => false,
    }
}
fn string_method(s: &str, method: &str, args: &[Val]) -> Result<Val, String> {
    Ok(match method {
        "slice" => {
            let chars: Vec<char> = s.chars().collect();
            let start = args.first().map(|v| to_num(v) as usize).unwrap_or(0).min(chars.len());
            let end = args.get(1).map(|v| to_num(v) as usize).unwrap_or(chars.len()).min(chars.len());
            Val::Str(chars[start..end.max(start)].iter().collect())
        }
        "includes" => Val::Bool(s.contains(&args.first().map(to_string).unwrap_or_default())),
        "split" => {
            let sep = args.first().map(to_string).unwrap_or_default();
            let parts: Vec<Val> = if sep.is_empty() {
                s.chars().map(|c| Val::Str(c.to_string())).collect()
            } else {
                s.split(&sep).map(|p| Val::Str(p.to_string())).collect()
            };
            Val::Arr(Rc::new(RefCell::new(parts)))
        }
        "trim" => Val::Str(s.trim().to_string()),
        "toLowerCase" => Val::Str(s.to_lowercase()),
        "toUpperCase" => Val::Str(s.to_uppercase()),
        "replace" | "replaceAll" => {
            // 정규식 인자는 미지원(Null) — 문자열 from 만. normURL 등 try/catch·dedup 안이라 비치명적.
            let from = args.first().map(to_string).unwrap_or_default();
            let to = args.get(1).map(to_string).unwrap_or_default();
            if from.is_empty() || from == "null" {
                Val::Str(s.to_string())
            } else if method == "replaceAll" {
                Val::Str(s.replace(&from, &to))
            } else {
                Val::Str(s.replacen(&from, &to, 1))
            }
        }
        "startsWith" => Val::Bool(s.starts_with(&args.first().map(to_string).unwrap_or_default())),
        "endsWith" => Val::Bool(s.ends_with(&args.first().map(to_string).unwrap_or_default())),
        "indexOf" => {
            let needle = args.first().map(to_string).unwrap_or_default();
            Val::Num(s.find(&needle).map(|i| s[..i].chars().count() as f64).unwrap_or(-1.0))
        }
        "padStart" => {
            let target = to_num(args.first().unwrap_or(&Val::Undefined)) as usize;
            let pad = args.get(1).map(to_string).unwrap_or_else(|| " ".to_string());
            let cur = s.chars().count();
            if cur >= target || pad.is_empty() {
                Val::Str(s.to_string())
            } else {
                let need = target - cur;
                let fill: String = pad.chars().cycle().take(need).collect();
                Val::Str(format!("{fill}{s}"))
            }
        }
        "repeat" => Val::Str(s.repeat(to_num(args.first().unwrap_or(&Val::Undefined)).max(0.0) as usize)),
        "charAt" => {
            let i = to_num(args.first().unwrap_or(&Val::Undefined)) as usize;
            Val::Str(s.chars().nth(i).map(|c| c.to_string()).unwrap_or_default())
        }
        "concat" => {
            let mut out = s.to_string();
            for a in args {
                out.push_str(&to_string(&a));
            }
            Val::Str(out)
        }
        // 정규식 의존(match/matchAll/search) 은 미니멀 — null 반환(치명 아님).
        "match" | "matchAll" | "search" => Val::Null,
        "normalize" => Val::Str(s.to_string()),
        other => return Err(format!("미지원 문자열 메서드: {other}")),
    })
}
fn object_values(v: &Val) -> Val {
    match v {
        Val::Obj(o) => Val::Arr(Rc::new(RefCell::new(o.borrow().values().cloned().collect()))),
        _ => Val::Arr(Rc::new(RefCell::new(vec![]))),
    }
}
fn object_keys(v: &Val) -> Val {
    match v {
        Val::Obj(o) => Val::Arr(Rc::new(RefCell::new(o.borrow().keys().map(|k| Val::Str(k.clone())).collect()))),
        _ => Val::Arr(Rc::new(RefCell::new(vec![]))),
    }
}
fn object_entries(v: &Val) -> Val {
    match v {
        Val::Obj(o) => Val::Arr(Rc::new(RefCell::new(
            o.borrow().iter().map(|(k, vv)| Val::Arr(Rc::new(RefCell::new(vec![Val::Str(k.clone()), vv.clone()])))).collect(),
        ))),
        _ => Val::Arr(Rc::new(RefCell::new(vec![]))),
    }
}

// ── JSON ↔ Val ──
pub fn json_to_val(j: &Json) -> Val {
    match j {
        Json::Null => Val::Null,
        Json::Bool(b) => Val::Bool(*b),
        Json::Number(n) => Val::Num(n.as_f64().unwrap_or(f64::NAN)),
        Json::String(s) => Val::Str(s.clone()),
        Json::Array(a) => Val::Arr(Rc::new(RefCell::new(a.iter().map(json_to_val).collect()))),
        Json::Object(o) => Val::Obj(Rc::new(RefCell::new(o.iter().map(|(k, v)| (k.clone(), json_to_val(v))).collect()))),
    }
}
pub fn val_to_json(v: &Val) -> Json {
    match v {
        Val::Undefined | Val::Null => Json::Null,
        Val::Bool(b) => Json::Bool(*b),
        Val::Num(n) => serde_json::Number::from_f64(*n).map(Json::Number).unwrap_or(Json::Null),
        Val::Str(s) => Json::String(s.clone()),
        Val::Arr(a) => Json::Array(a.borrow().iter().map(val_to_json).collect()),
        Val::Obj(o) => Json::Object(o.borrow().iter().map(|(k, vv)| (k.clone(), val_to_json(vv))).collect()),
        Val::Func(_) | Val::Native(_) => Json::Null,
    }
}
fn json_stringify(v: &Val) -> String {
    serde_json::to_string(&val_to_json(v)).unwrap_or_else(|_| "null".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // 테스트용 host — agent 호출을 기록, schema 의 status enum 으로 통과 placeholder 반환.
    struct RecHost {
        calls: Vec<(String, String)>, // (label, prompt)
    }
    impl Host for RecHost {
        fn agent(&mut self, prompt: &str, opts: &BTreeMap<String, Val>) -> Result<Val, String> {
            let label = opts.get("label").map(to_string).unwrap_or_default();
            self.calls.push((label.clone(), prompt.to_string()));
            // schema 의 required 를 통과값으로 채운 stub.
            let mut o = BTreeMap::new();
            if let Some(Val::Obj(sc)) = opts.get("schema") {
                if let Some(Val::Arr(req)) = sc.borrow().get("required") {
                    for k in req.borrow().iter() {
                        let key = to_string(k);
                        if key == "status" {
                            o.insert(key, Val::Str("done".into()));
                        } else {
                            o.insert(key, Val::Str(format!("<{}>", to_string(k))));
                        }
                    }
                }
            }
            Ok(Val::Obj(Rc::new(RefCell::new(o))))
        }
        fn phase(&mut self, _t: &str) {}
        fn log(&mut self, _m: &str) {}
    }

    fn parse(src: &str) -> Json {
        // 추출기 의 program 추출과 동일 형태를 acorn 으로 못 쓰므로, 테스트는 미리 만든 AST 사용.
        // 여기서는 외부 도구로 만든 program JSON 을 주입하는 대신, 간단 케이스를 serde_json 으로 구성.
        serde_json::from_str(src).unwrap()
    }

    #[test]
    fn literals_and_binop() {
        // program: return 1 + 2
        let prog = parse(r#"{"type":"Program","body":[{"type":"ReturnStatement","argument":{"type":"BinaryExpression","operator":"+","left":{"type":"Literal","value":1},"right":{"type":"Literal","value":2}}}]}"#);
        let mut h = RecHost { calls: vec![] };
        let mut interp = Interp::new(&mut h);
        let r = interp.run(&prog, Json::Null).unwrap();
        assert_eq!(to_string(&r), "3");
    }

    #[test]
    fn template_and_member_and_string_concat() {
        // const a = {n:2}; return `x` + a.n
        let prog = parse(r#"{"type":"Program","body":[
          {"type":"VariableDeclaration","declarations":[{"type":"VariableDeclarator","id":{"type":"Identifier","name":"a"},"init":{"type":"ObjectExpression","properties":[{"type":"Property","key":{"type":"Identifier","name":"n"},"value":{"type":"Literal","value":2},"computed":false}]}}]},
          {"type":"ReturnStatement","argument":{"type":"BinaryExpression","operator":"+","left":{"type":"Literal","value":"x"},"right":{"type":"MemberExpression","object":{"type":"Identifier","name":"a"},"property":{"type":"Identifier","name":"n"},"computed":false}}}
        ]}"#);
        let mut h = RecHost { calls: vec![] };
        let mut interp = Interp::new(&mut h);
        assert_eq!(to_string(&interp.run(&prog, Json::Null).unwrap()), "x2");
    }

    #[test]
    fn undefined_identifier_is_loud_not_silent() {
        // [기준] 미정의 식별자는 조용히 undefined 가 되면 안 된다(누락 전역/오타 은폐 = 꼼수).
        // return NOPE  → Err("미정의 식별자 …"). 구 동작은 Undefined 를 조용히 반환했음.
        let prog = parse(r#"{"type":"Program","body":[{"type":"ReturnStatement","argument":{"type":"Identifier","name":"NOPE"}}]}"#);
        let mut h = RecHost { calls: vec![] };
        match Interp::new(&mut h).run(&prog, Json::Null) {
            Err(e) => assert!(e.starts_with("미정의 식별자"), "loud 갭이어야: {e}"),
            Ok(_) => panic!("미정의 식별자가 조용히 통과됨(꼼수)"),
        }
    }

    #[test]
    fn typeof_undeclared_is_undefined_not_error() {
        // typeof 미선언 식별자 → "undefined"(JS: ReferenceError 안 남). 갭만 흡수.
        let prog = parse(r#"{"type":"Program","body":[{"type":"ReturnStatement","argument":{"type":"UnaryExpression","operator":"typeof","prefix":true,"argument":{"type":"Identifier","name":"NOPE"}}}]}"#);
        let mut h = RecHost { calls: vec![] };
        assert_eq!(to_string(&Interp::new(&mut h).run(&prog, Json::Null).unwrap()), "undefined");
    }
}
