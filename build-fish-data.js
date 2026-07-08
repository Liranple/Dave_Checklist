import fs from "node:fs";

const FANDOM_API =
  "https://dave-the-diver.fandom.com/api.php?action=parse&page=Fish&prop=text&format=json&origin=*";
const NAMU_URL =
  "https://namu.wiki/w/%EB%8D%B0%EC%9D%B4%EB%B8%8C%20%EB%8D%94%20%EB%8B%A4%EC%9D%B4%EB%B2%84/%EC%A7%80%EC%97%AD%20%EB%B0%8F%20%EC%83%9D%EB%AC%BC";

const AREA_NAMES = {
  "Blue Hole Shallows (0-50m)": "블루홀 초입 (0~50m)",
  "Blue Hole Medium Depth (50-130m)": "블루홀 중간수역 (50~130m)",
  "Blue Hole Depths (130-250m)": "블루홀 심층 (130~250m)",
  "Glacier Passage": "빙하 통로",
  "Glacier Zone": "빙하 지역",
  "Hydrothermal Vents": "열수 분출 구역",
  Aberrations: "이상 어종",
};

const ABERRATION_AREA_NAMES = {
  "Fog Coast": "안개 연안",
  "Black Cliff": "검은 절벽",
  "Jellyfish Basin": "해파리 유역",
};

const ACTIVE_TIME_MAP = {
  Day: "day",
  Night: "night",
  Both: "always",
};

const NAME_ALIASES = {
  "Redtoothed Triggerfish": "Redtooth Triggerfish",
};

const KOREAN_NAME_ALIASES = {
  "Devil Scorpionfish": "Devil Scorpion Fish",
  "Giant Wolf Eel": "Giant Wolffish",
  "Mantis Shrimp": "Mantis Shirimp",
  "Threetooth Puffer": "Threethooth Puffer",
  Blobfish: "Blob Fish",
};

const KOREAN_OVERRIDES = {
  "Big-Belly Seahorse": "빅벨리 해마",
  "Great White Shark Klaus": "백상아리 클라우스",
  "Jayakar's Seahorse": "자야카 해마",
  "Long-Snouted Seahorse": "갈귀 해마",
  "Mantis Shrimp": "맨티스쉬림프",
  "Pacific Seahorse": "태평양 해마",
  "Truck Hermit Crab": "트럭 소라게",
  "Dwarf Seahorse": "드워프 해마",
  "Giant Squid": "대왕오징어",
  "Giraffe Seahorse": "기린 해마",
  "Harlequin Hind": "할리퀸 하인드",
  "Hedgehog Seahorse": "고슴도치 해마",
  Lusca: "루스카",
  "Spiny Seahorse": "가시 해마",
  "Tiger-Tail Seahorse": "호랑이꼬리 해마",
  "Zebra Seahorse": "얼룩말 해마",
  "Clione Queen": "클리오네 퀸",
  "Crowned Seahorse": "왕관 해마",
  "Goblin Shark": "마귀상어",
  "Giant Wolf Eel": "거대늑대장어",
  "Lined Seahorse": "줄지어 해마",
  "Spotted Seahorse": "복해마",
  "White Seahorse": "하양 해마",
  "Leafy Seadragon": "나뭇잎해룡",
  "Phantom Jellyfish": "팬텀해파리",
  "Weedy Seadragon": "풀잎해룡",
  Helicoprion: "헬리코프리온",
  Kronosaurus: "크로노사우루스",
  "Ruby Seadragon": "루비해룡",
  Yawie: "알유",
  "Parhelion Jellyfish": "파헬리온 해파리",
};

function cleanText(value) {
  return value
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseFandomRows(html) {
  const data = [];
  const headings = [
    ...html.matchAll(
      /<h2[^>]*>[\s\S]*?<span class="mw-headline" id="([^"]+)">([\s\S]*?)<\/span>[\s\S]*?<\/h2>/g,
    ),
  ].map((match) => ({
    index: match.index,
    title: cleanText(match[2]),
  }));

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const nextHeading = headings[index + 1];
    const area = AREA_NAMES[heading.title];
    if (!area) continue;

    const sectionHtml = html.slice(
      heading.index,
      nextHeading ? nextHeading.index : html.length,
    );
    const rows = [...sectionHtml.matchAll(/<tr[\s\S]*?<\/tr>/g)].map(
      (match) => match[0],
    );

    for (const row of rows) {
      const image =
        row.match(/data-src="([^"]+Thumbnail\.png\/revision\/latest[^"]*?\?cb=\d+)"/) ||
        row.match(/href="([^"]+Thumbnail\.png\/revision\/latest[^"]*?\?cb=\d+)"/);
      const title = row.match(
        /<td[^>]*>\s*<a href="\/wiki\/[^"]+" title="([^"]+)">/,
      );
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) =>
        cleanText(match[1]),
      );

      if (!image || !title || cells.length < 3) continue;

      const eng = cleanText(title[1]);
      const rank = cells[2];
      if (!/^\d+$/.test(rank)) continue;
      const activeTime =
        heading.title === "Aberrations"
          ? "night"
          : ACTIVE_TIME_MAP[cells[3]] || "always";
      const itemArea =
        heading.title === "Aberrations"
          ? ABERRATION_AREA_NAMES[cells[3]] || area
          : area;

      data.push({
        category: "포획",
        area: itemArea,
        name: "",
        eng: NAME_ALIASES[eng] || eng,
        rank,
        activeTime,
        icon: image[1],
      });
    }
  }

  return data;
}

function parseNamuNames(html) {
  const map = {};

  for (const chunk of html.split("<td colspan='3'").slice(1)) {
    const cell = chunk.slice(0, chunk.indexOf("</td>"));
    const koMatch = cell.match(/<strong[^>]*>([\s\S]*?)<\/strong>/);
    const engMatch = cell.match(
      /<span class='wiki-size-down-1'[^>]*>([^<]+)<\/span>/,
    );
    if (!koMatch || !engMatch) continue;

    const ko = cleanText(koMatch[1]);
    const eng = cleanText(engMatch[1]).replace(/’/g, "'");
    if (ko.length > 30 || eng.length > 50) continue;
    if (!/[a-z]/.test(eng)) continue;
    map[eng] = ko;
  }

  return map;
}

const [fandomJson, namuHtml] = await Promise.all([
  fetch(FANDOM_API).then((response) => response.json()),
  fetch(NAMU_URL).then((response) => response.text()),
]);

const fish = parseFandomRows(fandomJson.parse.text["*"]);
const koreanByEng = parseNamuNames(namuHtml);

for (const item of fish) {
  item.name =
    KOREAN_OVERRIDES[item.eng] ||
    koreanByEng[item.eng] ||
    koreanByEng[KOREAN_NAME_ALIASES[item.eng]] ||
    koreanByEng[item.eng.replace(/-/g, " ")] ||
    item.eng;
}

const missingKo = fish.filter((item) => item.name === item.eng).map((item) => item.eng);
const byArea = fish.reduce((acc, item) => {
  acc[item.area] = (acc[item.area] || 0) + 1;
  return acc;
}, {});

fs.writeFileSync("public/data.js", `const FISH_DATA = ${JSON.stringify(fish, null, 2)};\n`);

console.log(`total ${fish.length}`);
console.log(JSON.stringify(byArea, null, 2));
console.log(`missing korean ${missingKo.length}`);
if (missingKo.length) console.log(missingKo.join("\n"));
