const shell = (body, script = "") => `<!doctype html><html><head><meta charset="utf-8"><title>Full page fixture</title><style>
body { margin: 12px; font: 16px/20px monospace; } p { margin: 4px 0; } iframe { display: block; width: 90%; height: 220px; border: 0; }
.feed { height: 240px; width: 520px; overflow: auto; position: relative; border: 1px solid; scroll-behavior: smooth; }
.row { height: 48px; margin: 0; white-space: pre-wrap; } .virtual .row { position: absolute; left: 0; top: 0; }
</style></head><body>${body}<script>${script}</script></body></html>`;
export const marker = (prefix, index) => `${prefix}_${String(index).padStart(3, "0")}_汉字😀`;
export const markers = (prefix, count) => Array.from({ length: count }, (_, i) => marker(prefix, i));

function virtual(prefix, count, recycle = false, hiddenAxis = false) {
	return shell(`<p>VIRTUAL_START</p>${hiddenAxis ? '<style>.feed { overflow-x:hidden;overflow-y:auto; }.pad { width:900px; }</style>' : ''}<div class="feed virtual"><div class="pad" style="height:${count * 48}px"></div><div class="rows"></div></div><p>VIRTUAL_END</p>`, `
	const feed = document.querySelector('.feed'), rows = document.querySelector('.rows');
	const count = ${count}, recycle = ${recycle};
	const slots = Array.from({length: 8}, () => { const el=document.createElement('div'); el.className='row'; return el; });
	function render() {
		if (${hiddenAxis}) feed.scrollLeft = 0;
		const start=Math.min(count-1, Math.floor(feed.scrollTop / 48));
		if (!recycle) rows.replaceChildren();
		for (let slot=0;slot<8;slot++) {
			const index=start+slot; let el=recycle ? slots[slot] : document.createElement('div'); el.className='row';
			if(index>=count){el.remove();continue;}
			if(!recycle) el.setAttribute('aria-rowindex', String(index+1));
			el.style.transform='translateY('+index*48+'px)';
			el.textContent='${prefix}_'+String(index).padStart(3,'0')+'_汉字😀\\nLEGAL_REPEAT';
			rows.append(el);
		}
	}
	feed.addEventListener('scroll', render); render();
	`);
}

export function fixturePage(path) {
	switch (path) {
		case "/static": return shell(`<p>STATIC_START</p>${markers("S", 80).map((value, i) => `<p data-record-id="p-${i}">${value} <b>inline</b> content.</p>`).join("")}
		<details name="group"><summary>First details</summary><p>EXPANDED_ONE</p></details>
		<details name="group"><summary>Second details</summary><p>EXPANDED_TWO</p></details>
		<form action="/forbidden-action" method="post"><button>Publish</button></form><p>STATIC_END</p>`);
		case "/virtual": return virtual("V", 36);
		case "/recycled": return virtual("R", 36, true);
		case "/hidden-axis": return virtual("H", 36, false, true);
		case "/grid": return shell('<p>GRID_START</p><div class="feed"><div style="width:960px;height:480px"></div><div class="cells"></div></div><p>GRID_END</p>', `
		const feed=document.querySelector('.feed'), cells=document.querySelector('.cells');
		function render(){cells.replaceChildren();for(let row=Math.floor(feed.scrollTop/80);row<Math.min(6,Math.floor(feed.scrollTop/80)+4);row++)for(let col=Math.floor(feed.scrollLeft/160);col<Math.min(6,Math.floor(feed.scrollLeft/160)+4);col++){const el=document.createElement('div');el.style.cssText='position:absolute;width:160px;height:80px;left:'+col*160+'px;top:'+row*80+'px';el.textContent='G_'+String(row*6+col).padStart(3,'0')+'_汉字😀';cells.append(el);}}
		feed.addEventListener('scroll',render);render();
		`);
		case "/lazy": return shell(`<p>NESTED_START</p><section style="height:320px;overflow:auto"><p>OUTER_START</p><div class="feed"></div><div style="height:400px"></div><p>OUTER_END</p></section><p>NESTED_END</p>`, `
		const feed=document.querySelector('.feed'); let count=0, loading=false;
		function append(){for(let end=Math.min(count+8,32);count<end;count++){const el=document.createElement('p');el.className='row';el.dataset.recordId='lazy-'+count;el.textContent='L_'+String(count).padStart(3,'0')+'_汉字😀';feed.append(el);}}
		feed.addEventListener('scroll',()=>{if(!loading&&count<32&&feed.scrollTop+feed.clientHeight>=feed.scrollHeight-5){loading=true;feed.setAttribute('aria-busy','true');setTimeout(()=>{append();loading=false;feed.removeAttribute('aria-busy');},250);}});append();
		`);
		case "/frames": return shell(`<p>FRAME_PARENT_START</p><iframe src="/same-frame"></iframe><iframe loading="lazy" src="http://frame.public.net/cross-frame"></iframe><iframe srcdoc="<p>SRCDOC_TEXT</p>"></iframe><iframe style="display:none" src="/hidden-auth"></iframe><p>FRAME_PARENT_END</p>`);
		case "/navigate": return shell(`<p>OBSOLETE_DOCUMENT</p><div style="height:2400px"></div><p>OBSOLETE_END</p>`, `window.addEventListener('scroll',()=>location.replace('/static'),{once:true});`);
		case "/frame-navigation": return shell('<p>OBSOLETE_PARENT</p><iframe src="/same-frame"></iframe>', `setTimeout(()=>location.replace('/static'),5000);`);
		case "/same-frame": return shell("<p>FRAME_SAME_TEXT</p>");
		case "/cross-frame": return shell(`<p>FRAME_CROSS_TEXT</p><iframe src="http://leaf.public.edu/leaf-frame"></iframe><p>FRAME_CROSS_END</p>`);
		case "/leaf-frame": return shell("<p>FRAME_NESTED_TEXT</p>");
		case "/hidden-auth": return shell('<p>HIDDEN_AUTH_SHOULD_NOT_APPEAR</p><input type="password">');
		case "/blocked-frame": return shell('<p>VISIBLE_PARENT_TEXT</p><iframe src="http://restricted.public.net/denied"></iframe><p>PARENT_END</p>');
		case "/large": return shell(`<pre>${"X".repeat(300000)}</pre>`);
		case "/infinite": return shell('<p>INFINITE_START</p><div class="feed"></div>', `
		const feed=document.querySelector('.feed');let count=0;
		function append(){for(let end=count+8;count<end;count++){const el=document.createElement('p');el.className='row';el.dataset.recordId='infinite-'+count;el.textContent='ITEM '+count;feed.append(el);}}
		feed.addEventListener('scroll',()=>{if(feed.scrollTop+feed.clientHeight>=feed.scrollHeight-5)append();});append();
		`);
		default: return undefined;
	}
}
