require("dotenv").config();
const crypto = require("crypto"), express = require("express"), { MongoClient } = require("mongodb");
const E = process.env;
if (!E.MONGODB_URI || !E.APP_PASSWORD) { console.error("Isi MONGODB_URI dan APP_PASSWORD di file .env"); process.exit(1); }
const app = express();
app.use(express.json({ limit: "1mb" }), express.urlencoded({ extended: true }));
let tx, cfg;

/* ---------- data ---------- */
const DEF = () => ({
  acc: [["cash", "Cash", "#1f8a5b", 100000], ["pulsa", "Agen Pulsa", "#b9770e", 200000], ["dana", "DANA", "#118eea", 100000],
        ["sea", "SeaBank", "#ee5a24", 100000], ["digi", "Digipos", "#c4182e", 200000], ["web3", "Saldo Web3", "#6b4eff", 0]]
    .map(([id, name, c, min]) => ({ id, name, c, awal: 0, min })), ppl: []
});
const getCfg = async () => (await cfg.findOne({ _id: "main" })) || DEF();
const STR = ["id", "date", "type", "sub", "cat", "note", "from", "to", "person"], NUM = ["ts", "modal", "jual", "fee"];
const pick = t => { const o = {}; STR.forEach(k => o[k] = String(t[k] ?? "").slice(0, 200)); NUM.forEach(k => o[k] = +t[k] || 0); return o; };

/* ---------- login (Basic Auth) ---------- */
const auth = (q, r, n) => {
  const h = q.headers.authorization || "";
  if (h.startsWith("Basic ")) {
    const p = Buffer.from(h.slice(6), "base64").toString().split(":").slice(1).join(":");
    const a = Buffer.from(p), b = Buffer.from(E.APP_PASSWORD);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return n();
  }
  r.set("WWW-Authenticate", 'Basic realm="Dompet Konter"').status(401).send("Login diperlukan");
};

/* ---------- API untuk web ---------- */
app.get("/api/state", auth, async (q, r) => {
  const c = await getCfg();
  const t = (await tx.find().sort({ ts: 1 }).toArray()).map(({ _id, ...x }) => x);
  r.json({ acc: c.acc, ppl: c.ppl, tx: t });
});
app.put("/api/config", auth, async (q, r) => {
  const { acc, ppl } = q.body || {};
  if (!Array.isArray(acc) || !Array.isArray(ppl)) return r.sendStatus(400);
  await cfg.updateOne({ _id: "main" }, { $set: { acc, ppl } }, { upsert: true });
  r.json({ ok: 1 });
});
app.post("/api/tx", auth, async (q, r) => {
  const t = pick(q.body || {});
  if (!t.id) return r.sendStatus(400);
  await tx.updateOne({ _id: t.id }, { $setOnInsert: t }, { upsert: true });
  r.json({ ok: 1 });
});
app.delete("/api/tx/:id", auth, async (q, r) => { await tx.deleteOne({ _id: q.params.id }); r.json({ ok: 1 }); });
app.get("/health", (q, r) => r.send("ok")); // untuk ping agar server gratis tidak tidur

/* ---------- WhatsApp ---------- */
const allowed = n => (E.WA_ALLOWED || "").split(",").map(s => s.replace(/\D/g, "")).filter(Boolean).includes(String(n).replace(/\D/g, ""));
async function send(to, msg, meta) {
  if (meta) return fetch(`https://graph.facebook.com/v20.0/${E.META_PHONE_ID}/messages`, {
    method: "POST", headers: { Authorization: "Bearer " + E.META_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: msg } })
  });
  return fetch("https://api.fonnte.com/send", { method: "POST", headers: { Authorization: E.FONNTE_TOKEN }, body: new URLSearchParams({ target: to, message: msg }) });
}
// verifikasi webhook Meta
app.get("/wa", (q, r) => {
  if (q.query["hub.mode"] === "subscribe" && q.query["hub.verify_token"] === E.WA_SECRET) return r.send(q.query["hub.challenge"]);
  r.sendStatus(403);
});
app.post("/wa", async (q, r) => {
  r.sendStatus(200);
  if (!E.WA_SECRET || q.query.key !== E.WA_SECRET) return;
  try {
    const b = q.body || {}; let from, text, meta = false;
    if (b.object === "whatsapp_business_account") {
      const m = b.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!m || m.type !== "text") return;
      from = m.from; text = m.text.body; meta = true;
    } else { from = b.sender; text = b.message; }
    if (!from || !text || !allowed(from)) return;
    await send(from, await handle(text), meta);
  } catch (e) { console.error(e); }
});

app.use(auth, express.static("public"));

/* ---------- aturan transaksi (sama dengan web) ---------- */
const eff = t => {
  const m = t.jual || 0;
  if (t.type === "jual") return [[t.from, -(t.modal || 0)], [t.to, m]];
  if (t.type === "pindah") return [[t.from, -(m + (t.fee || 0))], [t.to, m]];
  if (t.type === "keluar") return [[t.from, -m]];
  if (t.type === "tabung") return [[t.from, (t.sub === "setor" ? 1 : -1) * m]];
  return [[t.from, (t.sub === "bayar" ? 1 : -1) * m]];
};
const dFee = m => m <= 0 ? 0 : m < 50000 ? 3000 : m <= 2500000 ? 5000 : 5000 + 2500 * Math.ceil((m - 2500000) / 2500000);
const RULE = {
  topup: { cat: "Top Up DANA", fee: dFee }, pln: { cat: "PLN", fee: m => m > 0 ? 5000 : 0 },
  vc15: { cat: "VC 15k", p: [11000, 15000], from: "digi" }, vc20: { cat: "VC 20k", p: [15000, 20000], from: "digi" },
  vc25: { cat: "VC 25k", p: [20000, 25000], from: "digi" },
  paket: { cat: "Paket Data", from: "digi" }, pulsa: { cat: "Pulsa", from: "pulsa" }, game: { cat: "Game", from: "pulsa" },
  web3: { cat: "Web3 Buy" }, tarik: { cat: "Tarik Tunai" }, barang: { cat: "Barang" }
};
const ALIAS = { cash: "cash", kas: "cash", pulsa: "pulsa", dana: "dana", sea: "sea", seabank: "sea", digi: "digi", digipos: "digi", web3: "web3" };
const rp = n => (n < 0 ? "-" : "") + "Rp " + Math.abs(Math.round(n)).toLocaleString("id-ID");
const HELP = `Format entry:
topup 100000 [sea]
pln 100000 [sea]
vc15 | vc20 | vc25 [catatan]
paket | pulsa | game <modal> <jual> [catatan]
web3 <modal> <jual> [sea]
tarik <tunai keluar> <uang masuk> [sea]
barang <harga>
keluar <nominal> [akun] <alasan>
pindah <dari> <ke> <nominal> [admin]
saldo  |  hapus (batalkan entri WA terakhir)
Angka boleh 10k, 10rb, 2,5jt.`;
const ERR = "Format kurang pas. Kirim: bantuan";

function num(s) {
  let m;
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) return +s.replace(/\./g, "");
  if ((m = s.match(/^(\d+(?:[.,]\d+)?)(k|rb|ribu|jt|juta)?$/))) {
    let v = parseFloat(m[1].replace(",", ".")); const u = m[2];
    if (u === "k" || u === "rb" || u === "ribu") v *= 1e3; else if (u) v *= 1e6;
    return Math.round(v);
  }
  return NaN;
}

async function handle(text) {
  const [cmd, ...rest] = text.trim().toLowerCase().replace(/\s+/g, " ").split(" ");
  if (["bantuan", "help", "menu", "?"].includes(cmd)) return HELP;
  const c = await getCfg(), b = {};
  c.acc.forEach(a => b[a.id] = +a.awal || 0);
  for await (const t of tx.find()) eff(t).forEach(([k, d]) => { if (k in b) b[k] += d; });
  const name = id => (c.acc.find(a => a.id === id) || { name: id }).name, has = id => id in b;
  if (cmd === "saldo") return c.acc.map(a => `${a.name}: ${rp(b[a.id])}`).join("\n");
  if (cmd === "hapus") {
    const l = (await tx.find({ src: "wa" }).sort({ ts: -1 }).limit(1).toArray())[0];
    if (!l) return "Tidak ada entri dari WhatsApp yang bisa dihapus.";
    await tx.deleteOne({ _id: l._id });
    return `✓ Dihapus: ${l.cat || l.type} ${rp(l.jual)}`;
  }
  const nums = [], accs = [], note = [];
  rest.forEach(w => {
    const n = /^0\d{7,}$/.test(w) ? NaN : num(w);
    if (!isNaN(n)) nums.push(n); else if (ALIAS[w]) accs.push(ALIAS[w]); else note.push(w);
  });
  const R = RULE[cmd], ds = ["dana", "sea"], src = ds.includes(accs[0]) ? accs[0] : "dana";
  let o;
  if (cmd === "keluar") {
    if (!(nums[0] > 0)) return ERR;
    o = { type: "keluar", jual: nums[0], from: accs[0] || "cash" };
  } else if (cmd === "pindah") {
    if (accs.length < 2 || !(nums[0] > 0)) return ERR;
    o = { type: "pindah", from: accs[0], to: accs[1], jual: nums[0], fee: nums[1] || 0 };
  } else if (R) {
    if (R.fee) { if (!(nums[0] > 0)) return ERR; o = { modal: nums[0], jual: nums[0] + R.fee(nums[0]), from: src, to: "cash" }; }
    else if (R.p) o = { modal: R.p[0], jual: R.p[1], from: R.from, to: "cash" };
    else if (cmd === "barang") { if (!(nums[0] > 0)) return ERR; o = { modal: 0, jual: nums[0], from: "cash", to: "cash" }; }
    else {
      if (!(nums[0] >= 0 && nums[1] > 0)) return ERR;
      o = cmd === "tarik" ? { modal: nums[0], jual: nums[1], from: "cash", to: src }
        : cmd === "web3" ? { modal: nums[0], jual: nums[1], from: src, to: "cash" }
        : { modal: nums[0], jual: nums[1], from: R.from, to: "cash" };
    }
    o = { type: "jual", cat: R.cat, ...o };
  } else return "Perintah tidak dikenal. Kirim: bantuan";
  const t = {
    id: crypto.randomBytes(5).toString("hex"), ts: Date.now(), src: "wa", sub: "", cat: "", note: note.join(" "),
    date: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" }), modal: 0, jual: 0, fee: 0, from: "", to: "", person: "", ...o
  };
  for (const k of [t.from, t.to]) if (k && !has(k)) return `Saldo "${k}" tidak ada di pengaturan web.`;
  await tx.insertOne({ _id: t.id, ...t });
  const e = eff(t), after = { ...b };
  e.forEach(([k, d]) => { after[k] += d; });
  const ch = [...new Set(e.filter(x => x[1]).map(x => x[0]))];
  return `✓ ${t.cat || t.type} ${rp(t.jual)}` + (t.type === "jual" ? ` (laba ${rp(t.jual - t.modal)})` : "") +
    "\n" + ch.map(k => `${name(k)}: ${rp(after[k])}`).join("\n") + "\nSalah? kirim: hapus";
}

MongoClient.connect(E.MONGODB_URI).then(cl => {
  const d = cl.db(E.DB_NAME || "dompet");
  tx = d.collection("tx"); cfg = d.collection("config");
  app.listen(E.PORT || 3000, () => console.log("Dompet Konter jalan di port " + (E.PORT || 3000)));
}).catch(e => { console.error(e); process.exit(1); });
