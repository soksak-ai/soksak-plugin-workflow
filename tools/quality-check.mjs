// 4속성 품질 측정 — 프롬프트 개선 before/after 모니터(게이트 아님).
// 사용: node tools/quality-check.mjs <stage.jsonl> [label]
import fs from "fs";
const SELLER=/판매자|거래처|도매|공급자|공급상|공급업체/;
const SURFACE=/콘솔|접근면|포털|화면|대시보드|작업면|페이지|surface/;
const REG=/감사|규제|법정|보존기간|보존을|보존한다|준수|법령|이력|변조/;
const UMBRELLA=/(을|를|와|과)?\s*(관리한다|처리한다|제공한다|관리할 수 있어야|처리할 수 있어야|제공해야)/;
function bigrams(s){s=(s||"").replace(/[\s·,\-—()]/g,"");const g=new Set();for(let i=0;i<s.length-1;i++)g.add(s.slice(i,i+2));return g;}
function overlap(t,d){const T=bigrams(t),D=bigrams(d);if(!D.size)return 0;let i=0;for(const x of D)if(T.has(x))i++;return i/D.size;}
export function measure(path,label){
  const d=JSON.parse(fs.readFileSync(path,"utf8"));const rs=(d.requirements||[]).map(r=>({t:r.title||"",d:r.description||"",e:r.effort||"?"}));
  const BUYERPG=/구매\s*(페이지|목록)|구매페이지|구매목록/;
  const sellerSurf=rs.filter(r=>SELLER.test(r.t)&&SURFACE.test(r.t)&&!BUYERPG.test(r.t));
  const reg=rs.filter(r=>REG.test(r.t)||REG.test(r.d));
  const regMax=reg.filter(r=>r.e==="max"||r.e==="xhigh");
  const umb=rs.filter(r=>UMBRELLA.test(r.t.trim()));
  const ov=rs.map(r=>overlap(r.t,r.d));const ovMean=ov.reduce((a,b)=>a+b,0)/(ov.length||1);
  return {label,reqs:rs.length,sellerSurface:sellerSurf.length,sellerSurfaceTitles:sellerSurf.map(r=>r.t.slice(0,44)),
    reg:reg.length,regMaxXhigh:regMax.length,regRatio:reg.length?+(regMax.length/reg.length).toFixed(2):null,
    umbrella:umb.length,descOverlapMean:+ovMean.toFixed(3)};
}
if(process.argv[1]&&process.argv[1].endsWith("quality-check.mjs")&&process.argv[2]){
  const m=measure(process.argv[2],process.argv[3]||"");
  console.log(`${(m.label||"").padEnd(14)} | reqs ${String(m.reqs).padStart(3)} | 판매자surface ${m.sellerSurface}${m.sellerSurfaceTitles.length?" "+JSON.stringify(m.sellerSurfaceTitles):""} | 규제 ${m.reg}→hi ${m.regMaxXhigh}(${m.regRatio}) | umbrella ${m.umbrella} | desc겹침 ${m.descOverlapMean}`);
}
