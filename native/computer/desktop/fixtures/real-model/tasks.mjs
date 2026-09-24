export const miniTasks = [
	"click-test-2",
	"enter-text",
	"click-checkboxes",
	"choose-list",
	"click-tab-2",
	"drag-box",
	"scroll-text",
	"login-user",
];
export const chromeTasks = {
	"chrome-form":
		"Fill Name with 王小明 café, City with Hangzhou, tick the consent checkbox, choose Pro plan, and Submit. Confirm the visible receipt.",
	"chrome-navigation":
		"Open the Records link, find record R-204, open it, and set its note to reviewed 你好. Save and confirm the receipt.",
	"chrome-tabs":
		"Open Reference in a new tab. Read its code, return to the original tab, enter that code into Answer and Submit. Keep the reference tab open.",
	"chrome-scroll": "Scroll down to the Bottom confirmation button, click it, and confirm the visible receipt.",
	"chrome-dialog":
		"Click Open dialog. In the dialog enter approved 你好 into Comment and click Confirm. Verify the visible receipt.",
};
export const caseIds = [...miniTasks.map((id) => `miniwob:${id}`), ...Object.keys(chromeTasks)];

export function checkOracle(id, value) {
	if (id.startsWith("miniwob:")) return value?.done === true && value.rawReward === 1;
	if (id === "chrome-form")
		return (
			value?.name === "王小明 café" && value.city === "Hangzhou" && value.consent === "on" && value.plan === "Pro"
		);
	if (id === "chrome-navigation") return value?.record === "R-204" && value.note === "reviewed 你好";
	if (id === "chrome-tabs") return value?.answer === "REF-729";
	if (id === "chrome-scroll") return value?.bottom === true;
	if (id === "chrome-dialog") return value?.comment === "approved 你好";
	return false;
}

export function pageHtml(id, title, pathname) {
	const form = (body) =>
		`<form onsubmit="event.preventDefault();done(Object.fromEntries(new FormData(this)))">${body}<button>Submit</button></form>`;
	let body;
	if (id === "chrome-form")
		body = form(
			'<label>Name <input name="name"></label><label>City <input name="city"></label><label>Consent <input type="checkbox" name="consent"></label><label>Plan <select name="plan"><option>Free</option><option>Pro</option></select></label>',
		);
	if (id === "chrome-navigation") {
		body =
			pathname === "/records"
				? '<h2>Records</h2><p>R-101 Pending</p><a href="/record">R-204</a><p>R-305 Complete</p>'
				: pathname === "/record"
					? `<h2>Record R-204</h2>${form('<input type="hidden" name="record" value="R-204"><label>Note <input name="note"></label>')}`
					: '<a href="/records">Records</a>';
	}
	if (id === "chrome-tabs")
		body =
			pathname === "/reference"
				? "<h2>Reference code: REF-729</h2>"
				: `<a href="/reference" target="_blank">Reference</a>${form('<label>Answer <input name="answer"></label>')}`;
	if (id === "chrome-scroll")
		body =
			'<p>Scroll to the bottom.</p><div style="height:2400px;background:linear-gradient(white,#ccd)"></div><button onclick="done({bottom:true})">Bottom confirmation</button>';
	if (id === "chrome-dialog")
		body =
			"<button onclick=\"document.querySelector('dialog').showModal()\">Open dialog</button><dialog><label>Comment <input id=\"comment\"></label><button onclick=\"done({comment:document.getElementById('comment').value});this.closest('dialog').close()\">Confirm</button></dialog>";
	return `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:20px system-ui;margin:40px}label{display:block;margin:20px 0}input,select,button{font:inherit}button{margin:12px;padding:8px}</style><h1>${id}</h1>${body}<p id="receipt"></p><script>async function done(value){await fetch('/oracle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});document.getElementById('receipt').textContent='Saved receipt: '+JSON.stringify(value)}</script>`;
}
