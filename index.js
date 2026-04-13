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

// URL thật của từng module (từ app_path trong HTML)
const APP_PATHS = {
  ket_qua_hoc_tap:   "ListPoint/listpoint_Brc1.asp",
  khung_ctdt:        "ViewProgram/ViewPrg_Brc1.asp",
  huong_dan:         "Help/default.asp",
  lich_thi:          "StdExamination/StdExamination.asp",
  ho_so_sinh_vien:   "StdInfo/StdInfo.asp",
  dang_ky_chuyen_de: "QuanlyChuyende/SVDK_Chuyende.asp",
  tkb:               "Register/RegisterPrint.asp",
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

  // Bước 0: Logout trước để reset session (VNU yêu cầu)
  await client.get(`${LOGIN_URL}?Logout=logout`, {
    headers: { "sec-fetch-user": "?1" },
  });

  // GET trang login — cookie jar tự lưu ASPSESSIONID
  const getRes = await client.get(LOGIN_URL, {
    headers: { "sec-fetch-user": "?1", "cache-control": "max-age=0" },
  });

  const $ = cheerio.load(getRes.data);
  const userField = $('input[type="text"]').first().attr("name")     || "txtLoginId";
  const passField = $('input[type="password"]').first().attr("name") || "txtPassword";

  const body = new URLSearchParams({
    chkSubmit:   "ok",
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

  // Debug log
  console.log("=== LOGIN DEBUG ===");
  console.log("POST status:", postRes.status);
  console.log("POST cookies:", postRes.headers["set-cookie"]);
  console.log("Body 500 chars:", postRes.data.substring(0, 500));
  console.log("==================");

  // Kiểm tra đăng nhập thất bại
  const doc = cheerio.load(postRes.data);
  if (doc('input[type="password"]').length > 0) {
    throw new Error("Sai tên đăng nhập hoặc mật khẩu");
  }

  return { client, jar };
}

// ── Fetch module: GET trực tiếp URL thật trong iframe ─────────────────────────
async function fetchModule(appPath, client, params = {}) {
  // URL dạng: https://daotao.vnu.edu.vn/dkmh/../../ListPoint/listpoint.asp
  // Thực tế resolve thành: https://daotao.vnu.edu.vn/ListPoint/listpoint.asp
  const url = `https://daotao.vnu.edu.vn/${appPath}`;

  const queryString = Object.keys(params).length
    ? "?" + new URLSearchParams(params).toString()
    : "";

  const res = await client.get(url + queryString, {
    headers: { "Referer": PAGE_URL },
  });

  return res.data;
}

// ── Parse bảng HTML ────────────────────────────────────────────────────────────
function parseTable(html, colMap) {
  const $ = cheerio.load(html);
  const rows = [];

  // Dữ liệu điểm nằm trong divList3, bỏ qua các div khác
  const container = $("#divList3").length ? $("#divList3") : $("body");

  container.find("tr").each((_, tr) => {
    const cols = $(tr).find("td")
      .map((_, td) => $(td).text().replace(/[\s ]+/g, " ").trim())
      .get();

    // Bỏ dòng header (STT, Mã MH...) và dòng tiêu đề học kỳ (colspan)
    const hasColspan = $(tr).find("td[colspan]").length > 0;
    if (hasColspan) return;
    if (cols.length < 4) return;
    // Bỏ dòng có STT không phải số
    if (!/^\d+$/.test(cols[0])) return;

    const obj = {};
    colMap.forEach((key, idx) => { if (key) obj[key] = cols[idx] || ""; });
    if (Object.values(obj).some((v) => v)) rows.push(obj);
  });

  return rows;
}

// ── Fetchers ───────────────────────────────────────────────────────────────────
async function getKetQuaHocTap(client, hocKy) {
  const html = await fetchModule(APP_PATHS.ket_qua_hoc_tap, client,
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
  const html = await fetchModule(APP_PATHS.khung_ctdt, client);
  const $ = cheerio.load(html);
  const blocks = [];
  let cur = null;

  // Lấy thông tin tổng quan từ divList1
  const tongQuan = {};
  $("#divList1 td").each((_, td) => {
    const txt = $(td).text().replace(/\s+/g, " ").trim();
    if (/Chương trình đào tạo:/i.test(txt)) tongQuan.ctdt = txt.replace(/Chương trình đào tạo:/i, "").trim();
    if (/Tổng số tín chỉ/i.test(txt)) tongQuan.tongTC = txt.replace(/Tổng số tín chỉ tích lũy:/i, "").trim();
    if (/Điểm TBCTL/i.test(txt)) tongQuan.diemTBCTL = txt.replace(/Điểm TBCTL:/i, "").trim();
  });

  // Parse bảng trong divList3: STT|MãMH|TênMôn|SốTC|Loại|TínhĐiểm|Điểm
  $("#divList3 tr").each((_, tr) => {
    const tds = $(tr).find("td");
    const cols = tds.map((_, td) => $(td).text().replace(/[\s\u00a0]+/g, " ").trim()).get();
    if (!cols.length) return;

    // Dòng tiêu đề khối: có td với colspan >= 2, text như "I Khối..."
    const firstTd = tds.first();
    const colspan = parseInt(firstTd.attr("colspan") || "1");
    if (colspan >= 2) {
      // Row đầu của khối: "I Khối kiến thức chung"
      // Row thứ 2: "Số TC bắt buộc: X / Y" — gắn vào cur
      // Mỗi row colspan thường có 2-3 td: tên khối | số TC bắt buộc | số TC lựa chọn
      const tdTexts = $(tr).find("td").map((_, td) => $(td).text().replace(/[\s\u00a0]+/g, " ").trim()).get().filter(Boolean);
      const tenKhoiText = tdTexts[0] || "";
      const batBuocText = tdTexts.find(t => /Số TC bắt buộc/i.test(t)) || "";
      const tuChonText  = tdTexts.find(t => /Số TC lựa chọn/i.test(t)) || "";

      if (/^(I|II|III|IV|V|VI|VII|VIII|IX|X)\s/i.test(tenKhoiText) || /khối/i.test(tenKhoiText)) {
        cur = {
          tenKhoi: tenKhoiText,
          soTCBatBuoc: batBuocText,
          soTCTuChon: tuChonText,
          monHoc: []
        };
        blocks.push(cur);
      } else if (cur && batBuocText) {
        cur.soTCBatBuoc = batBuocText;
        if (tuChonText) cur.soTCTuChon = tuChonText;
      }
      return;
    }

    // Dòng môn học: cols[0] là số thứ tự
    if (cur && cols.length >= 4 && /^\d+$/.test(cols[0].trim())) {
      cur.monHoc.push({
        stt:    cols[0],
        maMon:  cols[1],
        tenMon: cols[2],
        soTC:   cols[3],
        loai:   cols[4] ? cols[4].trim() : "Tự chọn",
        diem:   cols[6] || "",
      });
    }
  });

  // Parse bảng chứng chỉ (divList2 thứ 2)
  const chungChi = [];
  $("table").each((_, tbl) => {
    const header = $(tbl).find("td[colspan]").first().text().trim();
    if (/Xem chứng chỉ/i.test(header)) {
      $(tbl).next("table").find("tr").each((_, tr) => {
        const cols = $(tr).find("td").map((_, td) => $(td).text().replace(/\s+/g, " ").trim()).get().filter(Boolean);
        if (cols.length >= 3 && !/Trạng thái/i.test(cols[0])) {
          chungChi.push({
            trangThai: cols[0],
            maCT:      cols[1].trim(),
            tenCT:     cols[2],
            moTa:      cols[3] || "",
            soQD:      cols[4] || "",
            ngayQD:    cols[5] || "",
          });
        }
      });
    }
  });

  return { tongQuan, khoiKienThuc: blocks, chungChi };
}

async function getLichThi(client) {
  const html = await fetchModule(APP_PATHS.lich_thi, client);
  return parseTable(html, ["stt","maMon","tenMon","ngayThi","ca","phong","hinhThuc"]);
}

async function getHoSoSinhVien(client) {
  const html = await fetchModule("StdInfo/TabStdInfo.asp", client);
  const $ = cheerio.load(html);
  const info = {};

  // Các field cần bỏ qua
  const skipKeys = ["STT", "Tên hồ sơ", "url"];
  const skipPattern = /^\d+$/;

  $("table tr").each((_, tr) => {
    const tds = $(tr).find("td");
    // Xử lý từng cặp td liên tiếp (layout 2 cột: label | value)
    for (let i = 0; i < tds.length - 1; i += 2) {
      const key = $(tds[i]).text().replace(/[\s\u00a0]+/g, " ").trim();
      const val = $(tds[i+1]).text().replace(/[\s\u00a0]+/g, " ").trim();
      if (!key || skipKeys.includes(key) || skipPattern.test(key)) continue;
      if (key.length < 60 && key.includes(":")) {
        info[key.replace(/:$/, "")] = val;
      }
    }
  });

  return info;
}

async function getDangKyChuyenDe(client) {
  const html = await fetchModule(APP_PATHS.dang_ky_chuyen_de, client);
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
  const html = await fetchModule(APP_PATHS.huong_dan, client);
  const $ = cheerio.load(html);
  const tb = [];
  const seen = new Set();

  // Ưu tiên lấy các thẻ <a> có href (bỏ trùng)
  $("a[href]").each((_, el) => {
    const text = $(el).text().replace(/[\s\u00a0]+/g, " ").trim();
    const href = $(el).attr("href") || "";
    if (text.length > 10 && !seen.has(text)) {
      seen.add(text);
      tb.push({ noidung: text, link: href });
    }
  });

  // Lấy thêm các thông báo dạng <li>, <p> không có link
  $("li, p").each((_, el) => {
    const text = $(el).text().replace(/[\s\u00a0]+/g, " ").trim();
    if (text.length > 20 && !seen.has(text)) {
      seen.add(text);
      tb.push({ noidung: text, link: "" });
    }
  });

  return tb.slice(0, 25);
}

// ── Debug dump HTML trang điểm ────────────────────────────────────────────────
app.post("/debug-html", async (req, res) => {
  const { username, password, intent = "ket_qua_hoc_tap" } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Thiếu thông tin" });
  let client;
  try {
    ({ client } = await login(username, password));
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }
  const moduleId = APP_PATHS[intent] || APP_PATHS.ket_qua_hoc_tap;
  const html = await fetchModule(moduleId, client);
  // Trả về 3000 ký tự đầu của HTML
  return res.json({ html: html });
});

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
