const express  = require("express");
const axios    = require("axios");
const cheerio  = require("cheerio");
const { CookieJar } = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");

const app = express();
app.use(express.json());

const BASE_URL  = "https://daotao.vnu.edu.vn/dkmh";
const LOGIN_URL = `${BASE_URL}/login.asp`;
const PAGE_URL  = `${BASE_URL}/default.asp`;

const MODULES = {
  ket_qua_hoc_tap:   "386",
  khung_ctdt:        "413",
  huong_dan:         "376",
  lich_thi:          "379",
  ho_so_sinh_vien:   "373",
  dang_ky_chuyen_de: "412",
};

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

// ── Tạo axios instance với cookie jar tự động ─────────────────────────────────
function createClient() {
  const jar = new CookieJar();
  const client = wrapper(axios.create({
    jar,
    withCredentials: true,
    maxRedirects: 5,
    validateStatus: (s) => s < 500,
    headers: {
      "User-Agent":                UA,
      "Accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language":           "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
      "sec-ch-ua":                 '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
      "sec-ch-ua-mobile":          "?0",
      "sec-ch-ua-platform":        '"Windows"',
      "sec-fetch-dest":            "document",
      "sec-fetch-mode":            "navigate",
      "sec-fetch-site":            "same-origin",
      "upgrade-insecure-requests": "1",
    },
  }));
  return { client, jar };
}

// ── Login ──────────────────────────────────────────────────────────────────────
async function login(username, password) {
  const { client, jar } = createClient();

  // GET trang login — cookie jar tự lưu ASPSESSIONID
  const getRes = await client.get(LOGIN_URL, {
    headers: { "sec-fetch-user": "?1", "cache-control": "max-age=0" },
  });

  const $ = cheerio.load(getRes.data);
  const userField = $('input[type="text"]').first().attr("name")     || "txtLoginId";
  const passField = $('input[type="password"]').first().attr("name") || "txtPassword";

  const body = new URLSearchParams({
    chkSubmit:   "",
    [userField]: username,
    [passField]: password,
  });

  // POST login — cookie jar tự gửi lại ASPSESSIONID + nhận cookies mới
  const postRes = await client.post(LOGIN_URL, body.toString(), {
    headers: {
      "Content-Type":   "application/x-www-form-urlencoded",
      "Referer":        LOGIN_URL,
      "Origin":         "https://daotao.vnu.edu.vn",
      "sec-fetch-user": "?1",
      "cache-control":  "max-age=0",
      "dnt":            "1",
    },
  });

  // Kiểm tra đăng nhập thất bại
console.log("POST status:", postRes.status);
console.log("POST cookies:", postRes.headers["set-cookie"]);
console.log("Body 300 chars:", postRes.data.substring(0, 300));
const doc = cheerio.load(postRes.data);
if (doc('input[type="password"]').length > 0) {
  
  const doc = cheerio.load(postRes.data);
  if (doc('input[type="password"]').length > 0) {
    throw new Error("Sai tên đăng nhập hoặc mật khẩu");
  }

  return { client, jar };
}

// ── Load module qua cookie first=PortalModule_XXX ─────────────────────────────
async function fetchModule(moduleId, client, extraForm = {}) {
  // Set cookie first trước khi request
  await client.defaults.jar.setCookie(
    `first=PortalModule_${moduleId}`,
    "https://daotao.vnu.edu.vn"
  );

  const body = new URLSearchParams(extraForm);

  const res = await client.post(PAGE_URL, body.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer":      PAGE_URL,
    },
  });

  return res.data;
}

// ── Parse bảng HTML ────────────────────────────────────────────────────────────
function parseTable(html, colMap) {
  const $ = cheerio.load(html);
  const rows = [];

  $("table tr").each((i, tr) => {
    const isHeader = $(tr).find("th").length > 0;
    if (isHeader) return;

    const cols = $(tr).find("td")
      .map((_, td) => $(td).text().replace(/\s+/g, " ").trim())
      .get();

    if (cols.length < 2) return;

    const obj = {};
    colMap.forEach((key, idx) => { if (key) obj[key] = cols[idx] || ""; });
    if (Object.values(obj).some((v) => v)) rows.push(obj);
  });

  return rows;
}

// ── Fetchers ───────────────────────────────────────────────────────────────────
async function getKetQuaHocTap(client, hocKy) {
  const html = await fetchModule(MODULES.ket_qua_hoc_tap, client,
    hocKy ? { cboTerm: hocKy } : {}
  );
  const rows = parseTable(html, ["stt","maMon","tenMon","soTinChi","diemHe10","diemChu","diemHe4"]);
  const valid = rows.filter((r) => parseFloat(r.diemHe4) > 0);
  const tongTC = valid.reduce((s, r) => s + (parseFloat(r.soTinChi) || 0), 0);
  const gpa4 = tongTC
    ? (valid.reduce((s,r) => s + (parseFloat(r.diemHe4)||0)*(parseFloat(r.soTinChi)||0), 0) / tongTC).toFixed(2)
    : null;
  const canhBaoMonYeu = rows.filter((r) => parseFloat(r.diemHe10) < 5 && r.diemHe10);
  return { danhSach: rows, tongSoMon: rows.length, tongTinChi: tongTC, gpa4, canhBaoMonYeu };
}

async function getKhungCTDT(client) {
  const html = await fetchModule(MODULES.khung_ctdt, client);
  const $ = cheerio.load(html);
  const blocks = [];
  let cur = null;
  $("table tr").each((_, tr) => {
    const cols = $(tr).find("td").map((_, td) => $(td).text().replace(/\s+/g, " ").trim()).get();
    if (!cols.length) return;
    if ($(tr).find('td[colspan]').length > 0 && cols.length <= 2 && cols[0].length > 10) {
      cur = { tenKhoi: cols[0], monHoc: [] };
      blocks.push(cur);
      return;
    }
    if (cur && cols.length >= 3) {
      cur.monHoc.push({ maMon: cols[0], tenMon: cols[1], tinChi: cols[2], loai: cols[3]||"", diem: cols[4]||"" });
    }
  });
  return blocks;
}

async function getLichThi(client) {
  const html = await fetchModule(MODULES.lich_thi, client);
  return parseTable(html, ["stt","maMon","tenMon","ngayThi","ca","phong","hinhThuc"]);
}

async function getHoSoSinhVien(client) {
  const html = await fetchModule(MODULES.ho_so_sinh_vien, client);
  const $ = cheerio.load(html);
  const info = {};
  $("table tr").each((_, tr) => {
    const cols = $(tr).find("td,th").map((_, td) => $(td).text().replace(/\s+/g, " ").trim()).get();
    if (cols.length >= 2 && cols[0]) info[cols[0]] = cols[1];
  });
  return info;
}

async function getDangKyChuyenDe(client) {
  const html = await fetchModule(MODULES.dang_ky_chuyen_de, client);
  const $ = cheerio.load(html);
  const ds = [];
  $("table tr").each((_, tr) => {
    const cols = $(tr).find("td").map((_, td) => $(td).text().replace(/\s+/g, " ").trim()).get();
    if (cols.length >= 2 && cols[0] && !/STT|Mã/i.test(cols[0])) {
      ds.push({ tenChuyenDe: cols[1]||cols[0], trangThai: cols[2]||"", ghiChu: cols[3]||"" });
    }
  });
  const chuaDangKy = ds.filter((d) => !d.trangThai || /chưa|không/i.test(d.trangThai));
  return {
    danhSach: ds,
    canhBao: chuaDangKy.length > 0
      ? `Bạn chưa đăng ký ${chuaDangKy.length} chuyên đề bắt buộc. Cần hoàn thành để đủ điều kiện xét tốt nghiệp!`
      : "Đã đăng ký đầy đủ chuyên đề.",
  };
}

async function getHuongDan(client) {
  const html = await fetchModule(MODULES.huong_dan, client);
  const $ = cheerio.load(html);
  const tb = [];
  $("a, li, p").each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    const href = $(el).attr("href") || "";
    if (text.length > 10) tb.push({ noidung: text, link: href });
  });
  return tb.slice(0, 20);
}

// ── Endpoint chính ─────────────────────────────────────────────────────────────
app.post("/query", async (req, res) => {
  const { username, password, intent = "ket_qua_hoc_tap", hocKy } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, error: "Thiếu username hoặc password" });
  }

  let client;
  try {
    ({ client } = await login(username, password));
  } catch (err) {
    return res.status(401).json({ success: false, error: err.message });
  }

  try {
    const fetchers = {
      ket_qua_hoc_tap:   () => getKetQuaHocTap(client, hocKy),
      khung_ctdt:        () => getKhungCTDT(client),
      lich_thi:          () => getLichThi(client),
      ho_so_sinh_vien:   () => getHoSoSinhVien(client),
      dang_ky_chuyen_de: () => getDangKyChuyenDe(client),
      huong_dan:         () => getHuongDan(client),
    };
    const keys = intent === "all" ? Object.keys(fetchers) : [intent];
    const data = {};
    await Promise.all(keys.filter((k) => fetchers[k]).map(async (k) => { data[k] = await fetchers[k](); }));
    return res.json({ success: true, intent, data });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── Debug endpoint ─────────────────────────────────────────────────────────────
app.post("/debug-login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Thiếu username/password" });
  try {
    const { client, jar } = await login(username, password);
    const cookies = await jar.getCookies("https://daotao.vnu.edu.vn");
    return res.json({ success: true, cookies: cookies.map((c) => `${c.key}=${c.value}`) });
  } catch (err) {
    return res.status(401).json({ success: false, error: err.message });
  }
});

// ── Health check ───────────────────────────────────────────────────────────────
app.get("/", (_, res) =>
  res.json({ status: "ok", service: "VNU Daotao Scraper", version: "4.0" })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`VNU Scraper v4.0 running on port ${PORT}`));
