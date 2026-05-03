import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "dist");
const publicDir = join(__dirname, "public");
const dataDir = join(__dirname, "data");
const storePath = join(dataDir, "store.json");
const port = Number(process.env.PORT || 4173);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

const clients = new Set();
let state = await loadStore();
let writeQueue = Promise.resolve();

function defaultStore() {
  return {
    meta: {
      eventName: "现金拍卖会",
      startTime: "10:00",
      sellerCommissionRate: 5,
      buyerCommissionRate: 10,
      returnCommissionRate: 5,
      updatedAt: new Date().toISOString()
    },
    itemCodes: [
      { code: "hn", name: "花鸟" },
      { code: "ss", name: "山水" },
      { code: "sf", name: "书法" }
    ],
    sellerCodes: [
      { code: "a", label: "あ" },
      { code: "i", label: "い" },
      { code: "u", label: "う" }
    ],
    customers: [
      { bidderNo: -1, sellerLabel: "", name: "流拍", actualSellerName: "", phone: "", sellerRate: "", buyerRate: "", returnRate: "" }
    ],
    lots: [],
    liveEntry: {},
    audit: []
  };
}

async function loadStore() {
  await mkdir(dataDir, { recursive: true });
  try {
    const text = await readFile(storePath, "utf8");
    return normalizeStore(JSON.parse(text));
  } catch {
    const fresh = defaultStore();
    await writeFile(storePath, JSON.stringify(fresh, null, 2));
    return fresh;
  }
}

function normalizeStore(raw) {
  const fresh = defaultStore();
  return {
    meta: { ...fresh.meta, ...(raw.meta || {}) },
    itemCodes: Array.isArray(raw.itemCodes) ? raw.itemCodes : fresh.itemCodes,
    sellerCodes: Array.isArray(raw.sellerCodes) ? raw.sellerCodes : fresh.sellerCodes,
    customers: Array.isArray(raw.customers) ? raw.customers : fresh.customers,
    lots: Array.isArray(raw.lots) ? raw.lots : [],
    liveEntry: raw.liveEntry && typeof raw.liveEntry === "object" ? raw.liveEntry : {},
    audit: Array.isArray(raw.audit) ? raw.audit.slice(-250) : []
  };
}

function persist() {
  state.meta.updatedAt = new Date().toISOString();
  writeQueue = writeQueue.then(() => writeFile(storePath, JSON.stringify(state, null, 2)));
  return writeQueue;
}

function broadcast(type = "state") {
  const payload = `event: ${type}\ndata: ${JSON.stringify({ type, at: new Date().toISOString() })}\n\n`;
  for (const client of clients) client.write(payload);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (!body) return {};
  return JSON.parse(body);
}

function addAudit(action, detail) {
  state.audit.push({ id: randomUUID(), at: new Date().toISOString(), action, detail });
  state.audit = state.audit.slice(-250);
}

function toNumber(value, fallback = 0) {
  if (value === "" || value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanLot(input, existing = {}) {
  const now = new Date().toISOString();
  return {
    id: existing.id || input.id || randomUUID(),
    itemNo: toNumber(input.itemNo, ""),
    sellerCode: String(input.sellerCode || "").trim().toLowerCase(),
    itemCode: String(input.itemCode || "").trim().toLowerCase(),
    quantity: toNumber(input.quantity, ""),
    buyerNo: input.buyerNo === "" || input.buyerNo === null || input.buyerNo === undefined ? "" : toNumber(input.buyerNo, ""),
    priceK: input.priceK === "" || input.priceK === null || input.priceK === undefined ? "" : toNumber(input.priceK, ""),
    buyerConfirmed: Boolean(input.buyerConfirmed),
    sellerConfirmed: Boolean(input.sellerConfirmed),
    returnConfirmed: Boolean(input.returnConfirmed),
    note: String(input.note || "").trim(),
    createdAt: existing.createdAt || now,
    updatedAt: now
  };
}

function cleanCustomer(input, existing = {}) {
  return {
    id: existing.id || input.id || randomUUID(),
    bidderNo: toNumber(input.bidderNo, ""),
    sellerLabel: String(input.sellerLabel || "").trim(),
    name: String(input.name || "").trim(),
    actualSellerName: String(input.actualSellerName || "").trim(),
    phone: String(input.phone || "").trim(),
    sellerRate: input.sellerRate === "" ? "" : toNumber(input.sellerRate, ""),
    buyerRate: input.buyerRate === "" ? "" : toNumber(input.buyerRate, ""),
    returnRate: input.returnRate === "" ? "" : toNumber(input.returnRate, "")
  };
}

function cleanLiveEntry(input) {
  const hasValue = ["sellerCode", "itemCode", "buyerNo", "priceK", "note"].some((key) => String(input[key] ?? "").trim() !== "");
  if (!hasValue) return {};
  return {
    ...cleanLot({ ...input, id: "live-entry", buyerConfirmed: false, sellerConfirmed: false, returnConfirmed: false }, { id: "live-entry" }),
    live: true
  };
}

function mergeCodes(kind, rows) {
  const cleaned = rows
    .map((row) => ({
      code: String(row.code || "").trim().toLowerCase(),
      name: String(row.name || row.label || "").trim(),
      label: String(row.label || row.name || "").trim()
    }))
    .filter((row) => row.code);
  if (kind === "items") {
    state.itemCodes = cleaned.map(({ code, name, label }) => ({ code, name: name || label }));
  } else {
    state.sellerCodes = cleaned.map(({ code, label, name }) => ({ code, label: label || name }));
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const input = String(text || "").replace(/^\ufeff/, "");
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell.trim());
      cell = "";
    } else if (char === "\n") {
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  if (!rows.length) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function pick(row, names) {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== "") return row[name];
  }
  return "";
}

function upsertCustomersFromCsv(rows) {
  let count = 0;
  for (const row of rows) {
    const bidderNo = pick(row, ["客户号牌", "客户编号", "买家编号", "货主编号", "bidderNo"]);
    const sellerLabel = pick(row, ["出货号牌", "货主号牌", "货主编号2", "sellerLabel"]);
    const name = pick(row, ["客户名称", "货主名称", "买家名称", "name"]);
    if (bidderNo === "" && sellerLabel === "" && name === "") continue;
    const input = {
      bidderNo,
      sellerLabel,
      name,
      actualSellerName: pick(row, ["货主实际名称", "actualSellerName"]),
      phone: pick(row, ["客户电话", "电话", "phone"]),
      sellerRate: pick(row, ["出货佣金比率", "货主佣金比率", "sellerRate"]),
      buyerRate: pick(row, ["买货佣金比率", "买家佣金比率", "buyerRate"]),
      returnRate: pick(row, ["退货佣金比率", "returnRate"])
    };
    const index = state.customers.findIndex(
      (customer) => String(customer.bidderNo) === String(toNumber(input.bidderNo, "")) && String(customer.sellerLabel || "") === String(input.sellerLabel || "")
    );
    const existing = index >= 0 ? state.customers[index] : {};
    const cleaned = cleanCustomer(input, existing);
    if (index >= 0) state.customers[index] = cleaned;
    else state.customers.push(cleaned);
    count += 1;
  }
  if (!state.customers.some((customer) => Number(customer.bidderNo) === -1)) {
    state.customers.unshift({ id: randomUUID(), bidderNo: -1, sellerLabel: "", name: "流拍", actualSellerName: "", phone: "", sellerRate: "", buyerRate: "", returnRate: "" });
  }
  return count;
}

function codeFromLabel(label) {
  return state.sellerCodes.find((row) => row.label === label)?.code || String(label || "").trim().toLowerCase();
}

function codeFromItemName(name) {
  const text = String(name || "").replace(/\s+(山売|\d+件)$/u, "").trim();
  return state.itemCodes.find((row) => row.name === text)?.code || String(name || "").trim().toLowerCase();
}

function appendLotsFromCsv(rows) {
  let count = 0;
  const hasLotColumns = rows.some((row) => pick(row, ["拍品编号", "itemNo"]) !== "" || pick(row, ["货主出货号牌缩写", "sellerCode"]) !== "");
  if (!hasLotColumns) return 0;
  for (const row of rows) {
    const itemNo = pick(row, ["拍品编号", "itemNo"]);
    const sellerCode = pick(row, ["货主出货号牌缩写", "sellerCode"]) || codeFromLabel(pick(row, ["货主号牌", "货主编号2"]));
    const itemCode = pick(row, ["拍品名称缩写", "itemCode"]) || codeFromItemName(pick(row, ["拍品名称"]));
    if (itemNo === "" && sellerCode === "" && itemCode === "") continue;
    const amount = toNumber(pick(row, ["成交价格", "成交金额", "amount"]), 0);
    const priceK = pick(row, ["千单位成交价", "priceK"]) || (amount ? amount / 1000 : "");
    state.lots.push(
      cleanLot({
        itemNo,
        sellerCode,
        itemCode,
        quantity: pick(row, ["拍品数量", "拍品点数", "quantity"]),
        buyerNo: pick(row, ["买家客户号牌", "买家编号", "buyerNo"]),
        priceK,
        buyerConfirmed: pick(row, ["买家确认", "buyerConfirmed"]) === "1",
        sellerConfirmed: pick(row, ["卖家确认", "sellerConfirmed"]) === "1",
        returnConfirmed: pick(row, ["退货确认", "returnConfirmed"]) === "1",
        note: pick(row, ["备注", "note"])
      })
    );
    count += 1;
  }
  return count;
}

async function routeApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/state") {
    sendJson(res, 200, state);
    return;
  }

  if (req.method === "POST" && pathname === "/api/meta") {
    const input = await readJson(req);
    state.meta = { ...state.meta, ...input };
    addAudit("更新场次设置", state.meta.eventName);
    await persist();
    broadcast();
    sendJson(res, 200, state);
    return;
  }

  if (req.method === "POST" && pathname === "/api/lots") {
    const input = await readJson(req);
    const lot = cleanLot(input);
    state.lots.push(lot);
    state.liveEntry = {};
    addAudit("新增成交", `${lot.itemNo || ""} ${lot.sellerCode}/${lot.itemCode}`);
    await persist();
    broadcast();
    sendJson(res, 201, lot);
    return;
  }

  if (req.method === "POST" && pathname === "/api/live-entry") {
    state.liveEntry = cleanLiveEntry(await readJson(req));
    broadcast();
    sendJson(res, 200, state.liveEntry);
    return;
  }

  if (req.method === "POST" && pathname === "/api/lots/bulk") {
    const input = await readJson(req);
    const ids = new Set(Array.isArray(input.ids) ? input.ids : []);
    let count = 0;
    if (input.action === "delete") {
      const before = state.lots.length;
      state.lots = state.lots.filter((lot) => !ids.has(lot.id));
      count = before - state.lots.length;
    } else {
      const keyMap = { buyer: "buyerConfirmed", seller: "sellerConfirmed", return: "returnConfirmed" };
      const key = keyMap[input.action];
      if (!key) return sendJson(res, 400, { error: "unknown_bulk_action" });
      state.lots = state.lots.map((lot) => {
        if (!ids.has(lot.id)) return lot;
        count += 1;
        return { ...lot, [key]: Boolean(input.value), updatedAt: new Date().toISOString() };
      });
    }
    addAudit("批量操作成交", `${input.action} ${count} 条`);
    await persist();
    broadcast();
    sendJson(res, 200, { ok: true, count });
    return;
  }

  if (req.method === "PUT" && pathname.startsWith("/api/lots/")) {
    const id = decodeURIComponent(pathname.split("/").pop());
    const index = state.lots.findIndex((lot) => lot.id === id);
    if (index < 0) return sendJson(res, 404, { error: "lot_not_found" });
    const input = await readJson(req);
    state.lots[index] = cleanLot(input, state.lots[index]);
    addAudit("更新成交", `${state.lots[index].itemNo || ""}`);
    await persist();
    broadcast();
    sendJson(res, 200, state.lots[index]);
    return;
  }

  if (req.method === "DELETE" && pathname.startsWith("/api/lots/")) {
    const id = decodeURIComponent(pathname.split("/").pop());
    const before = state.lots.length;
    state.lots = state.lots.filter((lot) => lot.id !== id);
    if (state.lots.length === before) return sendJson(res, 404, { error: "lot_not_found" });
    addAudit("删除成交", id);
    await persist();
    broadcast();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/customers") {
    const input = await readJson(req);
    const index = state.customers.findIndex((row) => String(row.id) === String(input.id));
    const existing = index >= 0 ? state.customers[index] : {};
    const customer = cleanCustomer(input, existing);
    if (index >= 0) state.customers[index] = customer;
    else state.customers.push(customer);
    addAudit(index >= 0 ? "更新客户" : "新增客户", `${customer.bidderNo} ${customer.name}`);
    await persist();
    broadcast();
    sendJson(res, 200, customer);
    return;
  }

  if (req.method === "DELETE" && pathname.startsWith("/api/customers/")) {
    const id = decodeURIComponent(pathname.split("/").pop());
    const before = state.customers.length;
    state.customers = state.customers.filter((row) => String(row.id) !== id);
    if (state.customers.length === before) return sendJson(res, 404, { error: "customer_not_found" });
    addAudit("删除客户", id);
    await persist();
    broadcast();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/codes/items") {
    mergeCodes("items", await readJson(req));
    addAudit("更新拍品代码", `${state.itemCodes.length} 条`);
    await persist();
    broadcast();
    sendJson(res, 200, state.itemCodes);
    return;
  }

  if (req.method === "POST" && pathname === "/api/codes/sellers") {
    mergeCodes("sellers", await readJson(req));
    addAudit("更新出货号牌代码", `${state.sellerCodes.length} 条`);
    await persist();
    broadcast();
    sendJson(res, 200, state.sellerCodes);
    return;
  }

  if (req.method === "POST" && pathname === "/api/import/csv") {
    const input = await readJson(req);
    const rows = parseCsv(input.csv);
    const customers = upsertCustomersFromCsv(rows);
    const lots = input.onlyCustomers ? 0 : appendLotsFromCsv(rows);
    addAudit("导入 CSV", `客户 ${customers} 条，成交 ${lots} 条`);
    await persist();
    broadcast();
    sendJson(res, 200, { ok: true, customers, lots });
    return;
  }

  if (req.method === "POST" && pathname === "/api/auction/clear") {
    const count = state.lots.length;
    state.lots = [];
    addAudit("清空本场拍卖数据", `${count} 条成交`);
    await persist();
    broadcast();
    sendJson(res, 200, { ok: true, count });
    return;
  }

  if (req.method === "GET" && pathname === "/api/export/full.csv") {
    const csv = buildCsv();
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"auction-full.csv\""
    });
    res.end(`\ufeff${csv}`);
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

function derive(lot) {
  const sellerCode = state.sellerCodes.find((row) => row.code === lot.sellerCode);
  const sellerLabel = sellerCode?.label || "";
  const seller = state.customers.find((row) => row.sellerLabel === sellerLabel) || {};
  const buyer = state.customers.find((row) => Number(row.bidderNo) === Number(lot.buyerNo)) || {};
  const item = state.itemCodes.find((row) => row.code === lot.itemCode);
  const amount = toNumber(lot.priceK, 0) * 1000;
  const isPending = lot.buyerNo === "";
  const isReturn = seller.bidderNo !== undefined && Number(seller.bidderNo) === Number(lot.buyerNo);
  const isNoBid = Number(lot.buyerNo) === -1;
  const returnType = isReturn ? "顶价退回" : isNoBid ? "流拍退回" : "";
  const sellerRate = isNoBid ? "NA" : toNumber(seller.sellerRate, 0) || toNumber(state.meta.sellerCommissionRate, 0);
  const buyerRate = isNoBid ? "NA" : toNumber(buyer.buyerRate, 0) || toNumber(state.meta.buyerCommissionRate, 0);
  const sellerCommission = isNoBid ? 0 : amount * Number(sellerRate) / 100;
  const buyerCommission = isNoBid ? 0 : amount * Number(buyerRate) / 100;
  const sellerTax = sellerCommission / 10;
  const buyerTax = buyerCommission / 10;
  const badReturnFlags = returnType && (lot.buyerConfirmed || lot.sellerConfirmed);
  const badNormalFlags = !returnType && lot.returnConfirmed;
  let status = "";
  if (lot.itemNo !== "") {
    if (badReturnFlags || badNormalFlags) status = "结算异常！";
    else if (isPending) status = "待拍";
    else if (returnType && lot.returnConfirmed) status = "已退回";
    else if (returnType === "顶价退回") status = "顶价待退回";
    else if (returnType === "流拍退回") status = "流拍待退回";
    else if (lot.buyerConfirmed && lot.sellerConfirmed) status = "已结算";
    else if (lot.buyerConfirmed) status = "等待货主结算";
    else if (lot.sellerConfirmed) status = "货主已结算|买家未付款";
    else status = "未结算";
  }
  const sellerActionMap = {
    "已退回": "已退",
    "待拍": "待拍",
    "未结算": "待买家",
    "等待货主结算": "可付",
    "顶价待退回": "顶待退",
    "流拍待退回": "流待退",
    "已结算": "完成",
    "货主已结算|买家未付款": "待收",
    "结算异常！": "结算异常！"
  };
  const sellerAction = sellerActionMap[status] || "";
  const buyerActionMap = {
    "已退": "已退",
    "待拍": "待拍",
    "待买家": "可收",
    "待收": "可收",
    "可付": "已收",
    "顶待退": "顶待退",
    "流待退": "流待退",
    "完成": "完成",
    "结算异常！": "结算异常！"
  };
  const itemName = item ? `${item.name}${lot.quantity === "" ? "" : Number(lot.quantity) > 3 ? " 山売" : ` ${lot.quantity}件`}` : "";
  return {
    ...lot,
    amount,
    sellerNo: seller.bidderNo ?? "",
    sellerLabel,
    sellerLotNo: sellerLabel ? `${sellerLabel}${state.lots.filter((row) => row.id === lot.id || (row.sellerCode === lot.sellerCode && Number(row.itemNo) <= Number(lot.itemNo || Infinity))).length}` : "",
    sellerName: seller.name || "",
    buyerName: buyer.name || "",
    itemName,
    sellerRate,
    sellerCommission,
    sellerTax,
    sellerNet: amount - sellerCommission - sellerTax,
    buyerRate,
    buyerCommission,
    buyerTax,
    buyerTotal: amount + buyerCommission + buyerTax,
    returnType,
    status,
    sellerAction,
    buyerAction: buyerActionMap[sellerAction] || ""
  };
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function buildCsv() {
  const columns = [
    ["拍品编号", "itemNo"],
    ["货主拍品编号", "sellerLotNo"],
    ["货主编号", "sellerNo"],
    ["货主号牌", "sellerLabel"],
    ["货主名称", "sellerName"],
    ["拍品名称", "itemName"],
    ["拍品点数", "quantity"],
    ["买家编号", "buyerNo"],
    ["买家名称", "buyerName"],
    ["成交价格", "amount"],
    ["货主佣金比率", "sellerRate"],
    ["货主佣金", "sellerCommission"],
    ["货主佣金消费税", "sellerTax"],
    ["扣除货主佣金后结算额", "sellerNet"],
    ["买家佣金比率", "buyerRate"],
    ["买家佣金", "buyerCommission"],
    ["买家佣金消费税", "buyerTax"],
    ["加算买家佣金后结算额", "buyerTotal"],
    ["退回判定", "returnType"],
    ["结算状态", "status"]
  ];
  const rows = state.lots.map(derive).sort((a, b) => Number(a.itemNo) - Number(b.itemNo));
  return [
    columns.map(([label]) => csvCell(label)).join(","),
    ...rows.map((row) => columns.map(([, key]) => csvCell(row[key])).join(","))
  ].join("\n");
}

async function serveStatic(req, res, pathname) {
  const baseDir = await stat(distDir).then((info) => (info.isDirectory() ? distDir : publicDir)).catch(() => publicDir);
  const file = pathname === "/" ? join(baseDir, "index.html") : resolve(baseDir, `.${pathname}`);
  if (!file.startsWith(baseDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "Content-Type": mime[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      await routeApi(req, res, url.pathname);
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "server_error", message: error.message });
  }
});

server.listen(port, "0.0.0.0", () => {
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => `http://${item.address}:${port}`);
  console.log(`现金会协同系统已启动: http://localhost:${port}`);
  for (const address of addresses) console.log(`局域网访问: ${address}`);
});
