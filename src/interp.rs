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
            _ => Ok(Flow::Normal), // 미지원 statement 는 무시(전향)
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
                // 내장 전역 함수(콜백 전달 가능): Boolean/String/Number.
                if matches!(name, "Boolean" | "String" | "Number") {
                    return Ok(Val::Native(name.to_string()));
                }
                Ok(Val::Undefined)
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
                let arg = self.eval(node.get("argument").unwrap_or(&Json::Null), scope)?;
                let op = node.get("operator").and_then(|o| o.as_str()).unwrap_or("");
                Ok(match op {
                    "!" => Val::Bool(!truthy(&arg)),
                    "-" => Val::Num(-to_num(&arg)),
                    "+" => Val::Num(to_num(&arg)),
                    "typeof" => Val::Str(type_of(&arg).to_string()),
                    _ => Val::Undefined,
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
                let val = self.eval(node.get("right").unwrap_or(&Json::Null), scope)?;
                let target = node.get("left").unwrap_or(&Json::Null);
                self.assign(target, val.clone(), scope)?;
                Ok(val)
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
            _ => Ok(Val::Undefined),
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
        for t in thunks {
            match self.call_value(&t, vec![], scope) {
                Ok(v) => out.push(v),
                Err(_) => out.push(Val::Null), // thunk throw → null
            }
        }
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
        for (idx, item) in items.into_iter().enumerate() {
            let mut prev = item.clone();
            let mut dropped = false;
            for st in &stages {
                match self.call_value(st, vec![prev.clone(), item.clone(), Val::Num(idx as f64)], scope) {
                    Ok(v) => prev = v,
                    Err(_) => {
                        dropped = true;
                        break;
                    }
                }
            }
            out.push(if dropped { Val::Null } else { prev });
        }
        Ok(Val::Arr(Rc::new(RefCell::new(out))))
    }

    fn call_value(&mut self, f: &Val, args: Vec<Val>, _caller: &Scope) -> Result<Val, String> {
        if let Val::Native(name) = f {
            let a0 = args.first().cloned().unwrap_or(Val::Undefined);
            return Ok(match name.as_str() {
                "Boolean" => Val::Bool(truthy(&a0)),
                "String" => Val::Str(to_string(&a0)),
                "Number" => Val::Num(to_num(&a0)),
                _ => Val::Undefined,
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
        match obj {
            Val::Arr(a) => self.array_method(a, method, args, scope),
            Val::Str(s) => Ok(string_method(s, method, &args)),
            Val::Obj(_) => {
                // .then(cb) — eager: obj 가 이미 해소된 값. cb(obj) 실행해 결과 반환(Promise.then 모사).
                if method == "then" {
                    if let Some(cb) = args.first() {
                        return self.call_value(cb, vec![obj.clone()], scope);
                    }
                }
                Ok(Val::Undefined)
            }
            _ => {
                // null/undefined .then 등 — eager 모델에서 null 전파.
                if method == "then" {
                    if let Some(cb) = args.first() {
                        return self.call_value(cb, vec![obj.clone()], scope);
                    }
                }
                Ok(Val::Undefined)
            }
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
            _ => Ok(Val::Undefined),
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
        Val::Obj(o) => o.borrow().get(key).cloned().unwrap_or(Val::Undefined),
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
fn string_method(s: &str, method: &str, args: &[Val]) -> Val {
    match method {
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
        "replace" => {
            let from = args.first().map(to_string).unwrap_or_default();
            let to = args.get(1).map(to_string).unwrap_or_default();
            Val::Str(s.replacen(&from, &to, 1))
        }
        _ => Val::Undefined,
    }
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
    fn interprets_cockpit_full_agent_set() {
        // [기준] 완전 skeleton.program 을 해석하면 cockpit 의 전 agent 가 나온다(요약은 1개였음).
        // w() 팩토리·IIFE·parallel·.then()·.filter(Boolean)·조건부 게이트를 실행으로 풀어낸다.
        let skeleton: Json = serde_json::from_str(include_str!("../fixtures/cockpit.skeleton.json")).unwrap();
        let program = skeleton.get("program").expect("program(완전 AST)");
        let mut h = RecHost { calls: vec![] };
        let mut interp = Interp::new(&mut h);
        interp.run(program, Json::Null).unwrap();
        let labels: Vec<String> = h.calls.iter().map(|(l, _)| l.clone()).collect();
        // 9 agent 전부 — 내가 정한 게 아니라 워크플로가 정함.
        for id in ["S0", "C1", "C2", "C3", "SPK-b", "SPK-c", "SPK-d", "T1", "T3"] {
            assert!(labels.iter().any(|l| l == id), "agent {id} 누락. 캡처: {labels:?}");
        }
        // ok('C6')=false 로 게이트된 T2 는 미실행.
        assert!(!labels.iter().any(|l| l == "T2"), "T2 는 게이트 미실행이어야: {labels:?}");
        assert_eq!(h.calls.len(), 9, "정확히 9 agent: {labels:?}");
    }
}
