const stylesheet = document.createElement('link');
stylesheet.rel = 'stylesheet';
stylesheet.href = 'cards-layout.css';
document.body.append(stylesheet);
const states = ['待办', '进行中', '待验收', '阻塞', '已完成'];
const colors = ['#9ca8b1', '#41bbdb', '#edba4b', '#f27878', '#40b393'];
const projects = [
  ['智能仓储 WMS','李明',[5,6,4,4,31]],
  ['供应链协同平台','王晨',[15,10,5,3,27]],
  ['设备预测性维护','周宁',[4,6,6,0,44]],
  ['质量管理 QMS','陈颖',[2,5,3,0,40]],
  ['生产执行 MES','赵阳',[12,9,2,0,27]],
  ['客户服务工作台','刘欣',[14,12,1,0,13]],
  ['采购订单协同','张帆',[3,5,2,0,30]],
  ['企业知识库','孙悦',[6,4,2,0,18]],
  ['设备巡检平台','吴磊',[8,6,4,0,22]],
  ['合同管理平台','郑敏',[5,3,2,0,10]],
  ['能耗监测平台','钱程',[9,5,3,0,13]],
  ['售后服务平台','何静',[4,6,2,0,18]],
  ['资产管理平台','林涛',[5,4,1,0,20]],
  ['生产排程平台','徐敏',[8,7,3,0,22]],
  ['供应商门户','陆洋',[6,3,1,0,15]],
];
document.querySelector('.portfolio > div:last-child').innerHTML = projects.map(([name,owner,counts]) => {
  const total = counts.reduce((a,b)=>a+b,0);
  let angle = -Math.PI / 2;
  const point = (a,r) => [160+Math.cos(a)*r,80+Math.sin(a)*r];
  const slices = counts.flatMap((n,i) => {
    if (!n) return [];
    const end = angle + n/total*Math.PI*2;
    const mid = (angle+end)/2;
    const [x1,y1] = point(angle,55);
    const [x2,y2] = point(end,55);
    const path = `<path d="M ${x1} ${y1} A 55 55 0 ${end-angle>Math.PI?1:0} 1 ${x2} ${y2}" fill="none" stroke="${colors[i]}" stroke-width="28"/>`;
    angle = end;
    return [{n,i,path,mid,right:Math.cos(mid)>=0,y:point(mid,70)[1]}];
  });
  // Spread nearby labels while keeping their angular order and sector anchors.
  for (const right of [false,true]) {
    const group = slices.filter(s=>s.right===right).sort((a,b)=>a.y-b.y);
    group.forEach((s,i)=> {s.y=Math.max(13,Math.min(147,s.y),i?group[i-1].y+20:13);});
    if (group.length && group.at(-1).y>147) {
      group.at(-1).y=147;
      for(let i=group.length-2;i>=0;i--) group[i].y=Math.min(group[i].y,group[i+1].y-20);
    }
  }
  const labels = slices.map(s=> {
    const anchor=point(s.mid,70);
    const elbow=point(s.mid,74);
    const endX=s.right?235:85;
    return `<polyline points="${anchor.join(',')} ${elbow[0]},${s.y} ${endX},${s.y}" fill="none" stroke="#859196" stroke-width="1"/><text x="${endX+(s.right?3:-3)}" y="${s.y}" dominant-baseline="middle" text-anchor="${s.right?'start':'end'}" font-size="13" font-weight="500" fill="#34434b">${s.n}项 ${Number((s.n/total*100).toFixed(1))}%</text>`;
  }).join('');
  const accessible=states.map((s,i)=>`${s}${counts[i]}项，占${Number((counts[i]/total*100).toFixed(1))}%`).join('；');
  return `<article class="project-card"><div class="card-title"><b>${name}</b><small>负责人 ${owner}</small></div><div class="chart-area"><svg viewBox="0 0 320 160" role="img" aria-label="${accessible}">${slices.map(s=>s.path).join('')}${labels}<text x="160" y="78" text-anchor="middle" font-size="22" fill="#34434b">${total}</text><text x="160" y="95" text-anchor="middle" font-size="10" fill="#65777e">任务总数</text></svg></div></article>`;
}).join('');
document.querySelector('.global-legend').innerHTML = states.map((s,i)=>`<span><i style="background:${colors[i]}"></i>${s}</span>`).join('');
document.querySelector('.portfolio .panel-head span').textContent = `全部 23 个项目 · 示例展示 ${projects.length} 个`;
document.querySelector('.footer').textContent = `示例数据 · ${projects.length} 个项目 · 数量和占比按各项目任务总数计算`;
