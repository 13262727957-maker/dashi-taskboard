import type { PublicProjectProgress } from '../api';
import { listPublicMemberProgress, type PublicMemberProgress } from '../api';
import { getAccountQuota, type AccountQuota } from '../api';
import { useEffect, useState } from 'react';
import { LinearIcon } from './LinearIcon';
import './PublicProjectBoard.css';

const names = ['待办', '进行中', '待验收', '阻塞', '已完成'];
const colors = ['#8a99ad', '#1677ff', '#faad14', '#ff4d4f', '#52c41a'];
function Chart({ row }: { row: PublicProjectProgress }) {
  const counts = [Math.max(0,row.total-row.active-row.review-row.blocked-row.done),row.active,row.review,row.blocked,row.done];
  let angle = -Math.PI/2;
  const point = (a:number,r:number) => [160+Math.cos(a)*r,80+Math.sin(a)*r];
  const slices = counts.flatMap((n,i) => {
    if (!n || !row.total) return [];
    const end = angle+n/row.total*Math.PI*2;
    const mid = (angle+end)/2;
    const a=point(angle,52), b=point(end,52);
    const d=`M ${a} A 52 52 0 ${end-angle>Math.PI?1:0} 1 ${b}`;
    angle=end;
    return [{n,i,mid,d,right:Math.cos(mid)>=0,y:point(mid,70)[1]}];
  });
  for(const right of [false,true]) {
    const group=slices.filter(s=>s.right===right).sort((a,b)=>a.y-b.y);
    group.forEach((s,i)=>{s.y=Math.max(13,Math.min(147,s.y),i?group[i-1].y+22:13);});
    if(group.length && group[group.length-1].y>147){
      group[group.length-1].y=147;
      for(let i=group.length-2;i>=0;i--) group[i].y=Math.min(group[i].y,group[i+1].y-22);
    }
  }
  return <svg viewBox="0 0 320 160" role="img" aria-label={counts.map((n,i)=>`${names[i]} ${n} 项`).join('，')}>
    <circle cx="160" cy="80" r="52" fill="none" stroke="#edf2f7" strokeWidth="28" />
    {slices.map(s=><g key={s.i}>
      {s.n===row.total ? <circle cx="160" cy="80" r="52" fill="none" stroke={colors[s.i]} strokeWidth="28"/> : <path d={s.d} fill="none" stroke={colors[s.i]} strokeWidth="28"/>}
      <polyline points={`${point(s.mid,67)} ${point(s.mid,72)[0]},${s.y} ${s.right?234:86},${s.y}`} fill="none" stroke="#8b9598"/>
      <text x={s.right?237:83} y={s.y} dominantBaseline="middle" textAnchor={s.right?'start':'end'} fontSize="12" fill="#34434b">{s.n}项 {Number((s.n/row.total*100).toFixed(1))}%</text>
    </g>)}
    <text x="160" y="79" textAnchor="middle" fontSize="23" fill="#34434b">{row.total}</text>
    <text x="160" y="96" textAnchor="middle" fontSize="11" fill="#65777e">任务总数</text>
  </svg>;
}

export default function PublicProjectBoard({projects,loading}:{projects:PublicProjectProgress[];loading:boolean}) {
  const [quota,setQuota]=useState<AccountQuota|null>(null);
  const [quotaFailed,setQuotaFailed]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();
    const refresh=()=>getAccountQuota(controller.signal).then(value=>{setQuota(value);setQuotaFailed(false);}).catch(()=>{if(!controller.signal.aborted){setQuota(null);setQuotaFailed(true);}});
    void refresh();
    const timer=window.setInterval(()=>void refresh(),60000);
    return ()=>{controller.abort();window.clearInterval(timer);};
  },[]);
  const [members,setMembers]=useState<PublicMemberProgress[]>([]);
  const [memberError,setMemberError]=useState('');
  const [memberLoading,setMemberLoading]=useState(true);
  const [page,setPage]=useState(0);
  const pages=1+Math.max(1,Math.ceil(members.length/24));
  const currentPage=page%pages;
  useEffect(()=>{
    const controller=new AbortController();
    setMemberLoading(true);
    listPublicMemberProgress(controller.signal).then(data=>{setMembers(data);setMemberError('');})
      .catch(error=>{if(!controller.signal.aborted)setMemberError(error.message||'成员数据读取失败');})
      .finally(()=>{if(!controller.signal.aborted)setMemberLoading(false);});
    return ()=>controller.abort();
  },[projects]);
  useEffect(()=>{
    const onKey=(event:KeyboardEvent)=>{
      if(event.repeat || !['Enter','Select','Accept'].includes(event.key))return;
      const target=event.target as HTMLElement;
      if(target.closest('input,textarea,select,[contenteditable="true"]'))return;
      event.preventDefault();
      setPage(p=>(p+1)%pages);
    };
    window.addEventListener('keydown',onKey);
    return ()=>window.removeEventListener('keydown',onKey);
  },[pages]);
  const visibleMembers=members.slice((currentPage-1)*24,currentPage*24);
  const memberTotal=members.reduce((s,m)=>s+m.total,0),memberDone=members.reduce((s,m)=>s+m.done,0);
  const total=projects.reduce((s,p)=>s+p.total,0),done=projects.reduce((s,p)=>s+p.done,0);
  const sorted=[...projects].sort((a,b)=>Number(b.blocked>0)-Number(a.blocked>0)||Number(b.review>0)-Number(a.review>0)||(b.updatedAt??'').localeCompare(a.updatedAt??''));
  const cards=sorted.slice(0,15);
  const stats=[['整体完成率',total?`${Math.round(done/total*100)}%`:'—',`已完成 ${done} / ${total} 项任务`],['项目总数',String(projects.length),'全部项目'],['已完成项目',String(projects.filter(p=>p.total>0&&p.done===p.total).length),'全部任务已完成'],['待验收任务',String(projects.reduce((s,p)=>s+p.review,0)),'全部项目'],['本周完成','未接入','暂无周期统计'],['账号余量','未接入','预计充值日期：未接入']];
  const displayedStats=currentPage===0?stats:[['成员人数',String(members.length),'未归档项目成员'],['任务总数',String(memberTotal),'已分配且未取消'],['整体完成率',memberTotal?`${Math.round(memberDone/memberTotal*100)}%`:'—',`已完成 ${memberDone} 项`],['待验收',String(members.reduce((s,m)=>s+m.review,0)),'项任务'],['阻塞任务',String(members.reduce((s,m)=>s+m.blocked,0)),'项任务'],['账号余量','未接入','预计充值日期：未接入']];
  return <section className="tv-board">
    <header><h1>{currentPage===0?'项目经营驾驶舱':'成员任务总览'}</h1><div className="tv-navigation"><span>{currentPage+1} / {pages}</span><button type="button" onClick={()=>setPage(p=>(p+1)%pages)}><LinearIcon name="chevronRight"/>下一页</button></div></header>
    <div className="tv-stats">{displayedStats.map(([label,value,detail])=>label==='账号余量'?<div key={label}><span>账号平均剩余额度</span><strong>{quota?`${quota.remainingPercent}%`:quotaFailed?'读取失败':'加载中'}</strong><small>{quota?`${quota.accountCount} 个账号 · ${quota.remainingDays===null?'可用天数无法估算':`预计还能用 ${quota.remainingDays} 天`}`:'来源：API 运营看板'}</small></div>:<div key={label}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>)}</div>
    <main><div className="tv-heading"><h2>{currentPage===0?'重点项目':'成员进展'}</h2><span>{currentPage===0?`展示 ${cards.length} / ${projects.length} 个项目`:`展示 ${visibleMembers.length} / ${members.length} 人`}</span></div>
      <div className="tv-legend">{names.map((name,i)=><span key={name}><i style={{background:colors[i]}}/>{name}</span>)}</div>
      {currentPage===0 ? (loading?<div role="status">正在加载项目数据…</div>:!projects.length?<div>暂无项目数据</div>:<div className="tv-cards">{cards.map(p=><article key={p.id}><div className="tv-title"><b title={p.name}>{p.name}</b><small>负责人：{p.ownerName||'未设置'}</small></div><Chart row={p}/></article>)}</div>) : memberLoading?<div role="status">正在加载成员数据…</div>:memberError?<div role="alert">{memberError}</div>:!members.length?<div>暂无成员数据</div>:<div className="tv-members">{visibleMembers.map(m=>{
        const todo=Math.max(0,m.total-m.done-m.active-m.review-m.blocked);
        return <article key={m.id}><b className="tv-member-name">{m.name}</b><div className="tv-member-rate"><strong>{m.total?Math.round(m.done/m.total*100):0}%</strong><span>已完成 {m.done} / {m.total} 项</span></div><div className="tv-member-bar" aria-label={`待办 ${todo}，进行中 ${m.active}，待验收 ${m.review}，阻塞 ${m.blocked}，已完成 ${m.done}`}>{[todo,m.active,m.review,m.blocked,m.done].map((n,i)=><i key={i} style={{width:`${m.total?n/m.total*100:0}%`,background:colors[i]}}/>)}</div><div className="tv-member-counts"><span>待办 {todo}</span><span>进行 {m.active}</span><span>验收 {m.review}</span><span>阻塞 {m.blocked}</span></div></article>;
      })}</div>}
    </main><footer>{currentPage===0?'统计范围：全部项目 · 优先展示阻塞、待验收及最近更新项目':'统计范围：未归档项目 · 完成率 = 已完成 / 已分配任务 · 不含已取消任务'}</footer>
  </section>;
}
