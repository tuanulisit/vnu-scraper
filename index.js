const express = require("express");
const axios   = require("axios");
const cheerio = require("cheerio");

const app = express();
app.use(express.json());

// ── Cấu hình ──────────────────────────────────────────────────────────────────
const BASE_URL  = "https://daotao.vnu.edu.vn/dkmh";
const LOGIN_URL = `${BASE_URL}/login.asp`;
const PAGE_URL  = `${BASE_URL}/default.asp`;

// Module ID map — confirmed từ Set-Cookie response
const MODULES = {
  ket_qua_hoc_tap:  "386",
  khung_ctdt:       "413",
  huong_dan:        "376",
  lich_thi:         "379",
  ho_so_sinh_vien:  "373",
  dang_ky_chuyen_de:"412",
};

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";

// ── Bước 1: Login → trả về session cookie ─────────────────────────────────────
async function login(username, password) {
  // GET trang login → lấy cookie phiên + hidden fields
  const getRes = await axios.get(LOGIN_URL, {
    headers: { "User-Agent": UA },
  });

  const initCookies = (getRes.headers["set-cookie"] || [])
    .map((c) => c.split(";")[0]).join("; ");

  const $ = cheerio.load(getRes.data);

  // Thu thập tất cả hidden fields (ASP ViewState, token,...)
  const hidden = {};
  $('input[type="hidden"]').each((_, el) => {
    const n = $(el).attr("name");
    if (n) hidden[n] = $(el).attr("value") || "";
  });

  // Tự detect tên field user/pass
  const userField = $('input[type="text"]').first().attr("name")     || "txtUser";
  const passField = $('input[type="password"]').first().attr("name") || "txtPass";
  const btnField  = $('input[type="submit"]').first().attr("name");

  const body = new URLSearchParams({
    ...hidden,
    [userField]: username,
    [passField]: password,
    ...(btnField ? { [btnField]: "Đăng nhập" } : {}),
  });

  const postRes = await axios.post(LOGIN_URL, body.toString(), {
    headers: {
      "User-Agent":   UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer":      LOGIN_URL,
      "Cookie":       initCookies,
    },
    maxRedirects: 5,
    validateStatus: (s) => s < 500,
  });

  const postCookies = (postRes.headers["set-cookie"] || [])
    .map((c) => c.split(";")[0]).join("; ");

  const session = [initCookies, postCookies].filter(Boolean).join("; ");

  // Kiểm tra đăng nhập thất bại
  const doc = cheerio.load(postRes.data);
  if (
    doc('input[type="password"]').length > 0 ||
    /sai.*mật khẩu|invalid|không đúng/i.test(postRes.data)
  ) {
    throw new Error("Sai tên đăng nhập hoặc mật khẩu");
  }

  return session;
}

// ── Bước 2: Load module bằng cách set cookie first=PortalModule_XXX ───────────
async function fetchModule(moduleId, session, extraForm = {}) {
  // Set cookie để server biết load module nào
  const cookieWithModule = `${session}; first=PortalModule_${moduleId}`;

  const body = new URLSearchParams({
    ...extraForm,
  });

  const res = await axios.post(PAGE_URL, body.toString(), {
    headers: {
      "User-Agent":   UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer":      PAGE_URL,
      "Cookie":       cookieWithModule,
    },
    validateStatus: (s) => s < 500,
  });

  return res.data;
}

// ── Parser: bảng HTML → mảng object ───────────────────────────────────────────
function parseTable(html, colMap) {
  const $ = cheerio.load(html);
  const rows = [];

  $("table tr").each((i, tr) => {
    const cols = $(tr).find("td")
      .map((_, td) => $(td).text().replace(/\s+/g, " ").trim())
      .get();

    if (cols.length < 2) return;

    // Bỏ dòng header (chứa toàn text in đậm hoặc dòng đầu)
    const isHeader = $(tr).find("th").length > 0 ||
      $(tr).find("td").first().find("b, strong").length > 0;
    if (isHeader) return;

    const obj = {};
    colMap.forEach((key, idx) => {
      if (key) obj[key] = cols[idx] || "";
    });
    if (Object.values(obj).some((v) => v)) rows.push(obj);
  });

  return rows;
}

// ── Fetchers theo từng module ──────────────────────────────────────────────────

async function getKetQuaHocTap(session, hocKy = "") {
  const html = await fetchModule(
    MODULES.ket_qua_hoc_tap,
    session,
    hocKy ? { cboTerm: hocKy } : {}
  );

  const rows = parseTable(html, [
    "stt", "maMon", "tenMon", "soTinChi",
    "diemHe10", "diemChu", "diemHe4",
  ]);

  // Tính GPA hệ 4 và hệ 10
  const valid = rows.filter((r) => parseFloat(r.diemHe4) > 0);
  const tongTC = valid.reduce((s, r) => s + (parseFloat(r.soTinChi) || 0), 0);
  const gpa4   = tongTC
    ? (valid.reduce((s, r) => s + (parseFloat(r.diemHe4) || 0) * (parseFloat(r.soTinChi) || 0), 0) / tongTC).toFixed(2)
    : null;

  // Cảnh báo môn dưới 5 hệ 10
  const canhBao = rows.filter((r) => parseFloat(r.diemHe10) < 5 && r.diemHe10);

  return { danhSach: rows, tongSoMon: rows.length, tongTinChi: tongTC, gpa4, canhBaoMonYeu: canhBao };
}

async function getKhungCTDT(session) {
  const html = await fetchModule(MODULES.khung_ctdt, session);
  const $ = cheerio.load(html);
  const blocks = [];
  let currentBlock = null;

  $("table tr").each((_, tr) => {
    const cols = $(tr).find("td")
      .map((_, td) => $(td).text().replace(/\s+/g, " ").trim())
      .get();

    if (!cols.length) return;

    // Dòng tiêu đề khối kiến thức (thường colspan lớn, text dài)
    const isSectionHeader = $(tr).find('td[colspan]').length > 0 && cols.length <= 2;
    if (isSectionHeader && cols[0].length > 10) {
      currentBlock = { tenKhoi: cols[0], batBuoc: "", tuChon: "", monHoc: [] };
      blocks.push(currentBlock);
      return;
    }

    if (currentBlock && cols.length >= 3) {
      currentBlock.monHoc.push({
        maMon:     cols[0] || "",
        tenMon:    cols[1] || "",
        tinChi:    cols[2] || "",
        loai:      cols[3] || "",   // BB / TC
        diemDat:   cols[4] || "",
      });
    }
  });

  return blocks;
}

async function getLichThi(session) {
  const html = await fetchModule(MODULES.lich_thi, session);
  return parseTable(html, [
    "stt", "maMon", "tenMon", "ngayThi", "ca", "phong", "hinhThuc",
  ]);
}

async function getHoSoSinhVien(session) {
  const html  = await fetchModule(MODULES.ho_so_sinh_vien, session);
  const $     = cheerio.load(html);
  const info  = {};

  $("table tr").each((_, tr) => {
    const cols = $(tr).find("td, th")
      .map((_, td) => $(td).text().replace(/\s+/g, " ").trim())
      .get();
    if (cols.length >= 2 && cols[0]) info[cols[0]] = cols[1];
  });

  return info;
}

async function getDangKyChuyenDe(session) {
  const html = await fetchModule(MODULES.dang_ky_chuyen_de, session);
  const $    = cheerio.load(html);
  const ds   = [];

  $("table tr").each((_, tr) => {
    const cols = $(tr).find("td")
      .map((_, td) => $(td).text().replace(/\s+/g, " ").trim())
      .get();
    if (cols.length >= 2 && cols[0] && !/STT|Mã/i.test(cols[0])) {
      ds.push({
        tenChuyenDe: cols[1] || cols[0],
        trangThai:   cols[2] || "",
        ghiChu:      cols[3] || "",
      });
    }
  });

  // Cảnh báo nếu chưa đăng ký chuyên đề nào
  const chuaDangKy = ds.filter((d) => !d.trangThai || /chưa|không/i.test(d.trangThai));

  return {
    danhSach: ds,
    canhBao: chuaDangKy.length > 0
      ? `Bạn chưa đăng ký ${chuaDangKy.length} chuyên đề bắt buộc. Cần hoàn thành để đủ điều kiện xét tốt nghiệp!`
      : "Đã đăng ký đầy đủ chuyên đề.",
  };
}

async function getHuongDan(session) {
  const html = await fetchModule(MODULES.huong_dan, session);
  const $    = cheerio.load(html);
  const tb   = [];

  // Lấy các thông báo/links quan trọng
  $("a, li, p").each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    const href = $(el).attr("href") || "";
    if (text.length > 10) tb.push({ noidung: text, link: href });
  });

  return tb.slice(0, 20); // Giới hạn 20 mục
}

// ── Endpoint chính ─────────────────────────────────────────────────────────────
// POST /query
// Body: { username, password, intent, hocKy? }
// intent: ket_qua_hoc_tap | khung_ctdt | lich_thi | ho_so_sinh_vien |
//         dang_ky_chuyen_de | huong_dan | all
app.post("/query", async (req, res) => {
  const { username, password, intent = "ket_qua_hoc_tap", hocKy } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, error: "Thiếu username hoặc password" });
  }

  // Login
  let session;
  try {
    session = await login(username, password);
  } catch (err) {
    return res.status(401).json({ success: false, error: err.message });
  }

  // Fetch
  try {
    const fetchers = {
      ket_qua_hoc_tap:   () => getKetQuaHocTap(session, hocKy),
      khung_ctdt:        () => getKhungCTDT(session),
      lich_thi:          () => getLichThi(session),
      ho_so_sinh_vien:   () => getHoSoSinhVien(session),
      dang_ky_chuyen_de: () => getDangKyChuyenDe(session),
      huong_dan:         () => getHuongDan(session),
    };

    const keys = intent === "all" ? Object.keys(fetchers) : [intent];
    const data = {};

    await Promise.all(
      keys
        .filter((k) => fetchers[k])
        .map(async (k) => { data[k] = await fetchers[k](); })
    );

    return res.json({ success: true, intent, data });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── Health check ───────────────────────────────────────────────────────────────
app.get("/", (_, res) =>
  res.json({ status: "ok", service: "VNU Daotao Scraper", version: "3.0" })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`VNU Scraper v3.0 running on port ${PORT}`));
