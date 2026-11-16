/* Tombola: logica condivisa tra server (Worker) e browser */
const PRIZES=[{k:'ambo',n:2,label:'Ambo'},{k:'terno',n:3,label:'Terno'},{k:'quaterna',n:4,label:'Quaterna'},{k:'cinquina',n:5,label:'Cinquina'},{k:'tombola',n:15,label:'Tombola'}];
const ALPH='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE=/^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{4}$/, SEED_RE=/^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{5}$/;
function randInt(n){const a=new Uint32Array(1);crypto.getRandomValues(a);return a[0]%n}
function randCode(len){let s='';for(let i=0;i<len;i++)s+=ALPH[randInt(ALPH.length)];return s}
function hashSeed(str){let h=1779033703^str.length;for(let i=0;i<str.length;i++){h=Math.imul(h^str.charCodeAt(i),3432918353);h=h<<13|h>>>19}h=Math.imul(h^h>>>16,2246822507);h=Math.imul(h^h>>>13,3266489909);return (h^h>>>16)>>>0}
function mulberry(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function shuffle(arr,r){for(let i=arr.length-1;i>0;i--){const j=Math.floor(r()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]]}return arr}
function colRange(c){return c===0?[1,9]:c===8?[80,90]:[c*10,c*10+9]}
const cardCache=new Map();
function makeCard(seed){
  if(cardCache.has(seed))return cardCache.get(seed);
  const r=mulberry(hashSeed('tombola:'+seed));
  let rows;
  for(let t=0;t<5000;t++){
    rows=[0,1,2].map(()=>shuffle([0,1,2,3,4,5,6,7,8],r).slice(0,5));
    if(new Set(rows.flat()).size===9)break;
  }
  const grid=[0,1,2].map(()=>Array(9).fill(null));
  for(let c=0;c<9;c++){
    const rs=[0,1,2].filter(i=>rows[i].includes(c));
    const [a,b]=colRange(c);const pool=[];for(let n=a;n<=b;n++)pool.push(n);
    const picks=shuffle(pool,r).slice(0,rs.length).sort((x,y)=>x-y);
    rs.forEach((ri,k)=>grid[ri][c]=picks[k]);
  }
  cardCache.set(seed,grid);return grid;
}
/* indice di estrazione (0-based) in cui la cartella raggiunge p numeri in una riga (p=15: tombola) */
function reachAt(grid,idx,p){
  if(p===15){let m=-1;for(const row of grid)for(const n of row){if(n==null)continue;const i=idx.get(n);if(i===undefined)return Infinity;m=Math.max(m,i)}return m}
  let best=Infinity;
  for(const row of grid){const is=row.filter(n=>n!=null&&idx.has(n)).map(n=>idx.get(n)).sort((a,b)=>a-b);if(is.length>=p)best=Math.min(best,is[p-1])}
  return best;
}
function idxOf(drawn){return new Map(drawn.map((n,i)=>[n,i]))}
/* assegna i premi non ancora vinti tra i candidati [{key,name,seeds}] */
function awardPrizes(drawn,prizes,cands){
  const idx=idxOf(drawn);const out={...prizes};let changed=false;
  for(const P of PRIZES){
    if(out[P.k])continue;
    let best=Infinity,winners=[];
    for(const c of cands){
      let cb=Infinity,cs=null;
      for(const s of c.seeds){const at=reachAt(makeCard(s),idx,P.n);if(at<cb){cb=at;cs=s}}
      if(cb===Infinity)continue;
      if(cb<best){best=cb;winners=[]}
      if(cb===best)winners.push({name:c.name,code:cs});
    }
    if(best<Infinity){out[P.k]={at:best,winners};changed=true}
  }
  return changed?out:prizes;
}
const SMORFIA=["L'Italia","'A piccerella","'A jatta","'O puorco","'A mano","Chella che guarda 'nterra","'O vasetto","'A Maronna","'A figliata","'E fasule","'E suricille","'O surdato","Sant'Antonio","'O mbriaco","'O guaglione","'O culo","'A disgrazzia","'O sanghe","'A resata","'A festa","'A femmena annura","'O pazzo","'O scemo","'E gguardie","Natale","Nanninella","'O cantero","'E zzizze","'O pate d''e criature","'E palle d''o tenente","'O padrone 'e casa","'O capitone","L'anne 'e Cristo","'A capa","L'aucelluzzo","'E castagnelle","'O monaco","'E mazzate","'A funa 'nganna","'A noia","'O curtiello","'O ccafè","'Onna pereta fore 'o balcone","'E ccancelle","'O vino bbuono","'E denare","'O muorto","'O muorto che parla","'O piezzo 'e carne","'O ppane","'O ciardino","'A mamma","'O viecchio","'O cappiello","'A museca","'A caruta","'O scartellato","'O paccotto","'E pile","Se lamenta","'O cacciatore","'O muorto acciso","'A sposa","'A sciammeria","'O chianto","'E ddoje zetelle","'O totaro int''a chitarra","'A zuppa cotta","Sottosopra","'O palazzo","L'ommo 'e merda","'A meraviglia","'O spitale","'A rotta","Pullecenella","'A funtana","'E diavule","'A bella figliola","'O mariuolo","'A vocca","'E sciure","'A tavula 'mbandita","'O maletiempo","'A chiesa","L'aneme 'o priatorio","'A puteca","'E perucchie","'E casecavalle","'A vecchia","'A paura"];
const clean=s=>String(s||'').replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,'').trim().slice(0,24);
export {PRIZES,ALPH,CODE_RE,SEED_RE,randInt,randCode,makeCard,reachAt,idxOf,awardPrizes,SMORFIA,clean,colRange};

