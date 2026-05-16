// 기상청 API허브 — 지상 관측(실황) + 예보구역 조회
import { KMA_API_KEY } from "./config.js";

const KMA_REG_URL = "https://apihub.kma.go.kr/api/typ01/url/fct_shrt_reg.php";
const KMA_SFCTM_URL = "https://apihub.kma.go.kr/api/typ01/url/kma_sfctm2.php";

// 지역별 예보구역코드
const REGION_MAP = {
  "서울": "11B10101",
  "송도": "11B20201",
  "인천": "11B20201",
  "경기": "11B20301",
  "강화": "11B20101",
  "김포": "11B20102",
  "수원": "11B20601",
  "안양": "11B20602",
  "오산": "11B20603",
  "화성": "11B20604",
  "성남": "11B20605",
  "평택": "11B20606",
  "용인": "11B20612",
  "의정부": "11B20301",
  "고양": "11B20302",
  "양주": "11B20304",
  "포천": "11B20403",
  "가평": "11B20404",
  "구리": "11B20501",
  "남양주": "11B20502",
  "양평": "11B20503",
  "하남": "11B20504",
  "춘천": "11D10301",
  "강릉": "11D20501",
  "속초": "11D20401",
  "고성": "11D20402",
  "경남고성": "11H20404",
  "양양": "11D20403",
  "원주": "11D10401",
  "횡성": "11D10402",
  "태백": "11D20301",
  "동해": "11D20601",
  "삼척": "11D20602",
  "철원": "11D10101",
  "화천": "11D10102",
  "인제": "11D10201",
  "양구": "11D10202",
  "홍천": "11D10302",
  "영월": "11D10501",
  "정선": "11D10502",
  "평창": "11D10503",
  "청주": "11C10301",
  "천안": "11C20301",
  "아산": "11C20302",
  "대전": "11C20401",
  "공주": "11C20402",
  "계룡": "11C20403",
  "세종": "11C20404",
  "충주": "11C10101",
  "진천": "11C10102",
  "음성": "11C10103",
  "제천": "11C10201",
  "단양": "11C10202",
  "보은": "11C10302",
  "괴산": "11C10303",
  "증평": "11C10304",
  "추풍령": "11C10401",
  "영동": "11C10402",
  "옥천": "11C10403",
  "서산": "11C20101",
  "태안": "11C20102",
  "당진": "11C20103",
  "홍성": "11C20104",
  "보령": "11C20201",
  "서천": "11C20202",
  "예산": "11C20303",
  "부여": "11C20501",
  "청양": "11C20502",
  "금산": "11C20601",
  "논산": "11C20602",
  "전주": "11F10201",
  "익산": "11F10202",
  "정읍": "11F10203",
  "완주": "11F10204",
  "장수": "11F10301",
  "무주": "11F10302",
  "진안": "11F10303",
  "남원": "11F10401",
  "임실": "11F10402",
  "순창": "11F10403",
  "광주": "11F20501",
  "장성": "11F20502",
  "나주": "11F20503",
  "담양": "11F20504",
  "화순": "11F20505",
  "구례": "11F20601",
  "곡성": "11F20602",
  "순천": "11F20603",
  "완도": "11F20301",
  "해남": "11F20302",
  "강진": "11F20303",
  "장흥": "11F20304",
  "여수": "11F20401",
  "광양": "11F20402",
  "고흥": "11F20403",
  "보성": "11F20404",
  "목포": "11F20801",
  "영암": "11F20802",
  "신안": "11F20803",
  "무안": "11F20804",
  "대구": "11H10701",
  "부산": "11H20201",
  "울산": "11H20101",
  "양산": "11H20102",
  "포항": "11H10201",
  "경주": "11H10202",
  "문경": "11H10301",
  "상주": "11H10302",
  "예천": "11H10303",
  "영주": "11H10401",
  "봉화": "11H10402",
  "영양": "11H10403",
  "안동": "11H10501",
  "의성": "11H10502",
  "청송": "11H10503",
  "김천": "11H10601",
  "구미": "11H10602",
  "고령": "11H10604",
  "성주": "11H10605",
  "창원": "11H20301",
  "김해": "11H20304",
  "통영": "11H20401",
  "사천": "11H20402",
  "거제": "11H20403",
  "남해": "11H20405",
  "하동": "11H20406",
  "함양": "11H20501",
  "거창": "11H20502",
  "합천": "11H20503",
  "밀양": "11H20601",
  "의령": "11H20602",
  "함안": "11H20603",
  "창녕": "11H20604",
  "진주": "11H20701",
  "산청": "11H20703",
  "울진": "11H10101",
  "영덕": "11H10102",
  "제주": "11G00201",
  "성산": "11G00101",
  "서귀포": "11G00401",
  "고산": "11G00501",
  "성판악": "11G00302",
  "추자도": "11G00800",
};

// 예보구역코드 → 가장 가까운 ASOS 지점번호
const REG_ID_TO_STN = {
  "11B10101": 108,
  "11B20201": 112,
  "11B20301": 98,
  "11B20101": 201,
  "11B20102": 98,
  "11B20601": 119,
  "11B20602": 202,
  "11B20603": 119,
  "11B20604": 119,
  "11B20605": 202,
  "11B20606": 119,
  "11B20612": 119,
  "11B20302": 98,
  "11B20304": 98,
  "11B20403": 98,
  "11B20404": 101,
  "11B20501": 108,
  "11B20502": 108,
  "11B20503": 114,
  "11B20504": 108,
  "11D10301": 101,
  "11D20501": 105,
  "11D20401": 90,
  "11D20402": 90,
  "11D20403": 90,
  "11D10401": 114,
  "11D10402": 114,
  "11D20301": 216,
  "11D20601": 106,
  "11D20602": 106,
  "11D10101": 95,
  "11D10102": 95,
  "11D10201": 95,
  "11D10202": 95,
  "11D10302": 101,
  "11D10501": 121,
  "11D10502": 121,
  "11D10503": 121,
  "11C10301": 131,
  "11C20301": 232,
  "11C20302": 232,
  "11C20401": 133,
  "11C20402": 133,
  "11C20403": 133,
  "11C20404": 133,
  "11C10101": 127,
  "11C10102": 127,
  "11C10103": 127,
  "11C10201": 221,
  "11C10202": 221,
  "11C10302": 131,
  "11C10303": 131,
  "11C10304": 131,
  "11C10401": 131,
  "11C10402": 131,
  "11C10403": 131,
  "11C20101": 177,
  "11C20102": 177,
  "11C20103": 177,
  "11C20104": 177,
  "11C20201": 235,
  "11C20202": 235,
  "11C20303": 232,
  "11C20501": 133,
  "11C20502": 133,
  "11C20601": 133,
  "11C20602": 133,
  "11F10201": 146,
  "11F10202": 146,
  "11F10203": 146,
  "11F10204": 146,
  "11F10301": 146,
  "11F10302": 146,
  "11F10303": 146,
  "11F10401": 146,
  "11F10402": 146,
  "11F10403": 146,
  "11F20501": 156,
  "11F20502": 156,
  "11F20503": 156,
  "11F20504": 156,
  "11F20505": 156,
  "11F20601": 165,
  "11F20602": 165,
  "11F20603": 165,
  "11F20301": 165,
  "11F20302": 165,
  "11F20303": 165,
  "11F20304": 165,
  "11F20401": 168,
  "11F20402": 168,
  "11F20403": 165,
  "11F20404": 165,
  "11F20801": 165,
  "11F20802": 165,
  "11F20803": 165,
  "11F20804": 165,
  "11H10701": 143,
  "11H20201": 159,
  "11H20101": 152,
  "11H20102": 152,
  "11H10201": 138,
  "11H10202": 138,
  "11H10301": 136,
  "11H10302": 136,
  "11H10303": 136,
  "11H10401": 136,
  "11H10402": 136,
  "11H10403": 136,
  "11H10501": 136,
  "11H10502": 136,
  "11H10503": 136,
  "11H10601": 143,
  "11H10602": 143,
  "11H10604": 143,
  "11H10605": 143,
  "11H20301": 155,
  "11H20304": 159,
  "11H20401": 162,
  "11H20402": 162,
  "11H20403": 162,
  "11H20404": 162,
  "11H20405": 162,
  "11H20406": 162,
  "11H20501": 143,
  "11H20502": 143,
  "11H20503": 143,
  "11H20601": 155,
  "11H20602": 155,
  "11H20603": 155,
  "11H20604": 155,
  "11H20701": 192,
  "11H20703": 192,
  "11H10101": 130,
  "11H10102": 130,
  "11G00201": 184,
  "11G00101": 188,
  "11G00401": 189,
  "11G00501": 185,
  "11G00302": 184,
  "11G00800": 184,
};

const WW_CODES = {
  "-": "관측 없음",
  0: "관측 없음",
  1: "맑음",
  2: "맑음",
  3: "구름 조금",
  4: "흐림",
  5: "안개",
  6: "눈",
  7: "비",
  8: "소나기",
  9: "뇌우",
  10: "연무",
  11: "황사",
  12: "박무",
  13: "연무",
  14: "가랑비",
  15: "소나기",
  16: "눈",
  17: "뇌우",
  18: "눈/비",
  19: "눈",
  20: "비",
  21: "눈",
  22: "비",
  23: "눈",
  24: "비",
  25: "눈",
  26: "비",
  27: "눈",
};

const WIND_DIR_16 = {
  0: "정보 없음",
  1: "북",
  2: "북북동",
  3: "북동",
  4: "동북동",
  5: "동",
  6: "동남동",
  7: "남동",
  8: "남남동",
  9: "남",
  10: "남남서",
  11: "남서",
  12: "서남서",
  13: "서",
  14: "서북서",
  15: "북서",
  16: "북북서",
};

function decodeKmaText(buffer) {
  try {
    return new TextDecoder("euc-kr").decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

function isMissing(value) {
  const n = Number(value);
  return value === "-" || value === "" || value === undefined || Number.isNaN(n) || n <= -90;
}

function formatNumber(value, digits = 1) {
  if (isMissing(value)) return null;
  return Number(Number(value).toFixed(digits));
}

function getStationId(regionName) {
  const regId = REGION_MAP[regionName] || REGION_MAP["서울"];
  return REG_ID_TO_STN[regId] || 108;
}

function describeClimate(row) {
  const ww = String(row.WW ?? "").trim();
  if (ww && ww !== "-" && WW_CODES[ww]) return WW_CODES[ww];
  if (ww && ww !== "-" && !Number.isNaN(Number(ww)) && WW_CODES[Number(ww)]) {
    return WW_CODES[Number(ww)];
  }

  const ca = formatNumber(row.CA);
  if (ca !== null) {
    if (ca <= 2) return "맑음";
    if (ca <= 5) return "구름 많음";
    return "흐림";
  }

  return "정보 없음";
}

function formatWindDirection(wd) {
  if (isMissing(wd)) return "정보 없음";
  const n = Number(wd);
  if (n >= 1 && n <= 16 && WIND_DIR_16[n]) return WIND_DIR_16[n];
  const dirs = ["북", "북북동", "북동", "동북동", "동", "동남동", "남동", "남남동", "남", "남남서", "남서", "서남서", "서", "서북서", "북서", "북북서"];
  const idx = Math.round(((n % 360) / 22.5)) % 16;
  return `${dirs[idx]} (${n}°)`;
}

function formatVisibility(meters) {
  const v = formatNumber(meters, 0);
  if (v === null) return "정보 없음";
  if (v >= 1000) return `${(v / 1000).toFixed(1)} km`;
  return `${v} m`;
}

function estimateUvIndex(si, cloudAmount) {
  const irradiance = formatNumber(si, 2);
  if (irradiance === null || irradiance <= 0) return { index: null, level: "정보 없음" };

  // 일사량(MJ/m²·h 근사) 기반 추정 UV 지수
  let uvi = Math.round(irradiance * 2.5);
  const ca = formatNumber(cloudAmount);
  if (ca !== null && ca > 5) uvi = Math.max(0, uvi - 2);
  if (ca !== null && ca > 8) uvi = Math.max(0, uvi - 2);

  let level = "낮음";
  if (uvi >= 11) level = "위험";
  else if (uvi >= 8) level = "매우 높음";
  else if (uvi >= 6) level = "높음";
  else if (uvi >= 3) level = "보통";

  return { index: uvi, level };
}

function parseSfctm2(text) {
  const lines = String(text || "").split(/\r?\n/);
  const headerLine = lines.find((line) => line.startsWith("#") && line.includes("YYMMDDHHMI"));
  const dataLine = lines.find((line) => /^\d{12}\s/.test(line.trim()));
  if (!headerLine || !dataLine) return null;

  const columns = headerLine.replace(/^#\s*/, "").trim().split(/\s+/);
  const values = dataLine.trim().split(/\s+/);
  if (columns.length !== values.length) return null;

  const row = {};
  columns.forEach((col, i) => {
    if (row[col] === undefined) row[col] = values[i];
  });
  return row;
}

async function fetchSurfaceObservation(stnId) {
  const url = `${KMA_SFCTM_URL}?stn=${stnId}&tm=0&authKey=${KMA_API_KEY}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`관측 API 요청 실패: ${response.status}`);
  }
  const text = decodeKmaText(await response.arrayBuffer());
  const row = parseSfctm2(text);
  if (!row) throw new Error("관측 데이터 파싱에 실패했습니다.");
  return row;
}

function formatObsTime(tm) {
  const s = String(tm || "");
  if (s.length < 12) return s;
  const y = s.slice(0, 4);
  const mo = s.slice(4, 6);
  const d = s.slice(6, 8);
  const h = s.slice(8, 10);
  const mi = s.slice(10, 12);
  return `${y}. ${Number(mo)}. ${Number(d)}. ${h}:${mi} (KST)`;
}

async function getWeatherForecast(regionName = "서울") {
  const displayRegion = regionName || "서울";
  const regId = REGION_MAP[displayRegion] || REGION_MAP["서울"];
  const stnId = getStationId(displayRegion);

  if (!KMA_API_KEY) {
    return { ok: false, error: "KMA_API_KEY가 설정되어 있지 않습니다. .env를 확인하세요." };
  }

  try {
    const row = await fetchSurfaceObservation(stnId);
    const climate = describeClimate(row);
    const temperature = formatNumber(row.TA, 1);
    const humidity = formatNumber(row.HM, 0);
    const visibility = formatVisibility(row.VS);
    const uv = estimateUvIndex(row.SI, row.CA);
    const windDir = formatWindDirection(row.WD);
    const windSpeed = formatNumber(row.WS, 1);
    const precipitation = formatNumber(row.RN, 1);

    return {
      ok: true,
      region: displayRegion,
      regId,
      stnId,
      observedAt: formatObsTime(row.YYMMDDHHMI),
      climate,
      temperature,
      humidity,
      visibility,
      uvIndex: uv.index,
      uvLevel: uv.level,
      solarIrradiance: formatNumber(row.SI, 2),
      windDir,
      windSpeed,
      precipitation,
      raw: row,
    };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

async function formatWeatherMessage(regionName = "서울") {
  const result = await getWeatherForecast(regionName);

  if (!result.ok) {
    return `오류: ${result.error}`;
  }

  const nowKST = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  const tempText = result.temperature !== null ? `${result.temperature}°C` : "정보 없음";
  const humidityText = result.humidity !== null ? `${result.humidity}%` : "정보 없음";
  const uvText =
    result.uvIndex !== null
      ? `지수 ${result.uvIndex} (${result.uvLevel})`
      : "정보 없음";
  const solarText =
    result.solarIrradiance !== null
      ? `${result.solarIrradiance} MJ/m² (일사량 기반 추정)`
      : "";

  const lines = [
    `🌤️ **${result.region} 날씨 정보**`,
    "",
    `**지역명**: ${result.region}`,
    `**관측 지점**: ${result.stnId}번 (예보구역 ${result.regId})`,
    `**관측 시각**: ${result.observedAt}`,
    `**봇 조회 시각**: ${nowKST}`,
    "",
    `**기후 상태**: ${result.climate}`,
    `**기온**: ${tempText}`,
    `**습도**: ${humidityText}`,
    `**가시거리**: ${result.visibility}`,
    `**자외선**: ${uvText}${solarText ? `\n- 일사량: ${solarText}` : ""}`,
  ];

  if (result.windSpeed !== null) {
    lines.push(`**풍속**: ${result.windSpeed} m/s (${result.windDir})`);
  }
  if (result.precipitation !== null && result.precipitation > 0) {
    lines.push(`**강수량**: ${result.precipitation} mm`);
  }

  lines.push("", "**데이터 출처**: 기상청 API허브 지상관측(ASOS)");

  return lines.join("\n");
}

export { getWeatherForecast, formatWeatherMessage, REGION_MAP };

export function getAvailableRegionsText() {
  const regions = Object.keys(REGION_MAP).sort();
  const groups = {
    "🏙️ 서울/인천/경기": regions.filter((r) =>
      ["서울", "송도", "인천", "경기", "강화", "김포", "수원", "안양", "오산", "화성", "성남", "평택", "용인", "의정부", "고양", "양주", "포천", "가평", "구리", "남양주", "양평", "하남"].includes(r),
    ),
    "🏔️ 강원": regions.filter((r) =>
      ["춘천", "강릉", "속초", "고성", "양양", "원주", "횡성", "태백", "동해", "삼척", "철원", "화천", "인제", "양구", "홍천", "영월", "정선", "평창"].includes(r),
    ),
    "🌾 충청": regions.filter((r) =>
      ["청주", "천안", "아산", "대전", "공주", "계룡", "세종", "충주", "진천", "음성", "제천", "단양", "보은", "괴산", "증평", "추풍령", "영동", "옥천", "서산", "태안", "당진", "홍성", "보령", "서천", "예산", "부여", "청양", "금산", "논산"].includes(r),
    ),
    "🌲 전라": regions.filter((r) =>
      ["전주", "익산", "정읍", "완주", "장수", "무주", "진안", "남원", "임실", "순창", "광주", "장성", "나주", "담양", "화순", "구례", "곡성", "순천", "완도", "해남", "강진", "장흥", "여수", "광양", "고흥", "보성", "목포", "영암", "신안", "무안"].includes(r),
    ),
    "🏖️ 경상": regions.filter((r) =>
      ["대구", "부산", "울산", "양산", "포항", "경주", "문경", "상주", "예천", "영주", "봉화", "영양", "안동", "의성", "청송", "김천", "구미", "고령", "성주", "창원", "김해", "통영", "사천", "거제", "경남고성", "남해", "하동", "함양", "거창", "합천", "밀양", "의령", "함안", "창녕", "진주", "산청", "울진", "영덕"].includes(r),
    ),
    "🌴 제주": regions.filter((r) => ["제주", "성산", "서귀포", "고산", "성판악", "추자도"].includes(r)),
  };

  let text = "**조회 가능한 지역 목록**\n\n";
  for (const [group, regionList] of Object.entries(groups)) {
    if (regionList.length > 0) {
      text += `${group}\n`;
      text += `${regionList.join(", ")}\n\n`;
    }
  }

  text += "**사용법**\n";
  text += "예) `!먼지야 날씨 서울`\n";
  text += "예) `!먼지야 송도 날씨`\n";
  text += "기본값: 서울\n";

  return text;
}
