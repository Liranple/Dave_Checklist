import { initializeApp, getApps } from "firebase/app";
import { doc, getDoc, getFirestore, onSnapshot, setDoc } from "firebase/firestore";
import { firebaseConfig, isFirebaseConfigured } from "./firebase-config.js";

const FISH_DATA = window.FISH_DATA || [];
// 초밥 데이터: 물고기와 동일한 형태(category/area/name/rank)라 상태·랭크·동기화 로직을 그대로 재사용한다.
// area는 재료 물고기가 속한 물고기 페이지 섹션과 동일하게 배정돼 있다(초밥은 그 섹션에 들어감).
const SUSHI_DATA = window.SUSHI_DATA || [];
// 요리 데이터: 초밥과 동일 구조(category/area/name/ing/rank/icon). area = 요리 섹션명.
const COOK_DATA = window.COOK_DATA || [];
const RANKS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "MAX"];
// ⚠️ 이 두 상수는 절대 바꾸지 말 것.
// 값을 바꾸면 기존 사용자의 localStorage 데이터(진행 기록)와 저장된 Sync Key가
// 새 키에서 조회되지 않아 "데이터가 날아간 것"처럼 보인다. (원격 데이터는 남아있지만 접근 불가)
const STORE_KEY = "dave_checklist_v2";
const SYNC_KEY_STORAGE = "dave_checklist_sync_key";

// 아이콘은 유니코드 글자 대신 SVG로(글자마다 세로 정렬이 달라 배지 안에서 안 맞던 문제 해결).
// 모두 24x24 뷰박스 중앙에 그려 원 안에 정확히 가운데 정렬된다. currentColor로 배지 색 상속.
const ACTIVE_TIME_META = {
  day: {
    icon:
      '<svg class="time-ico" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><circle cx="12" cy="12" r="4.4" fill="currentColor" stroke="none"></circle><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3M4.4 4.4l2.1 2.1M17.5 17.5l2.1 2.1M19.6 4.4l-2.1 2.1M6.5 17.5l-2.1 2.1"></path></g></svg>',
    label: "낮",
  },
  night: {
    icon:
      '<svg class="time-ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.5 1.8a10.5 10.5 0 1 0 5.7 12.9A8.4 8.4 0 0 1 16.5 1.8z"></path></svg>',
    label: "밤",
  },
  always: {
    icon:
      '<svg class="time-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.3" fill="none" stroke="currentColor" stroke-width="2.1"></circle><path fill="currentColor" d="M12 1.7a10.3 10.3 0 0 1 0 20.6z"></path></svg>',
    label: "항상",
  },
};

const AREA_ALL_VALUE = "";
const AREA_OPTIONS = [AREA_ALL_VALUE, ...new Set(FISH_DATA.map((fish) => fish.area))];

// 정렬 옵션(각 섹션 내에서만 적용). 이름/랭크 × 오름차순/내림차순.
const SORT_OPTIONS = [
  { value: "name-asc", label: "이름 가나다 순" },
  { value: "name-desc", label: "이름 가나다 역순" },
  { value: "rank-asc", label: "랭크 낮은 순" },
  { value: "rank-desc", label: "랭크 높은 순" },
];

const localStore = loadLocalStore();

let state = localStore.state;
let stateModifiedAt = localStore.modifiedAt;
// 현재 로컬 state가 어느 Sync Key에 속한 데이터인지 추적 (""=로컬 전용, 아직 동기화 안 됨).
// 키를 바꿔 연결할 때 서로 다른 키의 데이터가 섞이는 것을 막는 데 사용.
let stateOwnerKey = localStore.ownerKey;
let filters = { q: "", area: "", notMax: false, activeTime: "", party: "" };
// 정렬 기준(각 섹션 내부에서만 적용). 기본은 이름 오름차순.
let sortBy = "name-asc";
// 사이드바 탭: "fish"(물고기) | "cook"(요리) | "sushi"(초밥)
let activeTab = "fish";
// 물고기 카드 클릭 시 그 아래에 "이 물고기로 만드는 요리/초밥" 목록을 펼친다.
// 열려 있는 물고기의 키(getFishKey). null이면 닫힘.
let openDishFishKey = null;
// 부드러운 휠 스크롤(관성) 애니메이션을 중단하는 함수(아래 IIFE에서 실제 구현을 넣는다).
// 프로그램적 스크롤(탭 전환/대상 이동) 시 호출해 관성 루프가 되돌리는 것을 막는다.
let stopWheelScroll = () => {};
let openRankKey = null;
let areaMenuOpen = false;
let sortMenuOpen = false;
let resetModalOpen = false;
let loginModalOpen = false;
// 사용자가 접어둔 지역 이름 모음. 재렌더링(체크 등)에도 접힘 상태를 유지하기 위해 사용.
const collapsedAreas = new Set();

const sync = {
  key: localStorage.getItem(SYNC_KEY_STORAGE) || "",
  app: null,
  db: null,
  connected: false,
  connecting: false,
  unsubscribe: null,
  docRef: null,
  lastRemoteHash: "",
  saveTimer: null,
};

const $ = (id) => document.getElementById(id);

function loadLocalStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (raw && typeof raw === "object" && !Array.isArray(raw) && "state" in raw) {
      return {
        state: normalizeState(raw.state),
        modifiedAt: Number(raw.modifiedAt) || 0,
        ownerKey: typeof raw.ownerKey === "string" ? raw.ownerKey : "",
      };
    }
    return {
      state: normalizeState(raw || {}),
      modifiedAt: 0,
      ownerKey: "",
    };
  } catch {
    return { state: {}, modifiedAt: 0, ownerKey: "" };
  }
}

function normalizeEntry(entry, fallbackRank = "1") {
  return {
    checked: Boolean(entry?.checked),
    rank: normalizeRank(entry?.rank ?? fallbackRank),
    tank: Boolean(entry?.tank),
  };
}

function normalizeRank(rank) {
  if (rank === "99") return "9";
  if (rank === "M") return "MAX";
  return String(rank || "1");
}

function normalizeState(rawState) {
  if (!rawState || typeof rawState !== "object" || Array.isArray(rawState)) return {};

  return Object.fromEntries(
    Object.entries(rawState).map(([itemKey, entry]) => [itemKey, normalizeEntry(entry)]),
  );
}

function saveLocalStore() {
  localStorage.setItem(
    STORE_KEY,
    JSON.stringify({
      state,
      modifiedAt: stateModifiedAt,
      ownerKey: stateOwnerKey,
    }),
  );
}

function touchState() {
  stateModifiedAt = Date.now();
}

function getFishKey(fish) {
  return `${fish.category}::${fish.area}::${fish.name}`;
}

function getDefaultItem() {
  // 기본 랭크는 물고기·요리·초밥 모두 "1"(사용자가 직접 올리는 체크리스트이므로).
  return {
    checked: false,
    rank: "1",
    tank: false,
  };
}

function getItem(fish) {
  return state[getFishKey(fish)] || getDefaultItem(fish);
}

function persistState({ renderAfter = true } = {}) {
  touchState();
  saveLocalStore();
  scheduleRemoteSave();
  if (renderAfter) render();
}

function setItem(fish, patch) {
  state[getFishKey(fish)] = {
    ...getItem(fish),
    ...patch,
  };
  persistState();
}

// 빈 상태를 원격에 반영해도 되는지 여부.
// 평소엔 false라서 빈 state가 원격의 실제 데이터를 덮어쓰는 사고를 막는다.
// 사용자가 직접 "초기화"를 눌렀을 때만 true가 되어 의도된 비우기를 허용한다.
let allowEmptyRemotePush = false;

// 탭별 표시 이름과, 초기화 시 지워지는 항목 목록(모달에 표시).
const TAB_NAMES = { fish: "물고기", cook: "요리", sushi: "초밥" };
const RESET_ITEMS = { fish: ["랭크", "수족관"], cook: ["랭크"], sushi: ["랭크"] };

// 현재 보고 있는 탭(페이지)의 항목만 초기화한다.
function resetState() {
  const keys = new Set(activeDataset().map(getFishKey));
  Object.keys(state).forEach((k) => {
    if (keys.has(k)) delete state[k];
  });
  allowEmptyRemotePush = true;
  persistState({ renderAfter: false });
}

function getRankLabel(rank) {
  return rank === "MAX" ? "M" : rank;
}

// 관련 파티 키워드별 색상(파티 테마와 대충 연관). 요리/초밥 카드의 랭크 옆 배지에 사용.
const PARTY_COLORS = {
  랍스터: "#ff6a4d",
  카레: "#eaa32b",
  해파리: "#c98cff",
  참치: "#ff5470",
  새우: "#ff9d6b",
  오이: "#69c56a",
  청새치: "#4aa8ff",
  상어: "#8fa6bb",
};

// 파티 태그 배지. 클릭하면 그 태그를 가진 요리/초밥만 보이는 필터로 동작한다(낮/밤 배지처럼).
function partyBadges(list) {
  if (!list || !list.length) return "";
  return list
    .map((kw) => {
      const active = filters.party === kw;
      return (
        `<button type="button" class="party-badge party-filter${active ? " active" : ""}" ` +
        `data-party="${kw}" aria-pressed="${active}" style="--pc:${PARTY_COLORS[kw] || "#9fb4c2"}">${kw}</button>`
      );
    })
    .join("");
}

// 재료 중 가장 긴 것의 대략 폭(px, 12px 기준 근사). 반칸(≈112px)을 넘으면
// 균등 2열(가운데 반반)에서 잘리므로, 그 요리만 내용맞춤(가변) 열로 렌더한다.
function ingMaxWidth(ing) {
  const charW = (c) => (/[가-힣]/.test(c) ? 12 : /\d/.test(c) ? 6.5 : c === " " ? 3.5 : 7);
  return Math.max(
    ...String(ing)
      .split("\n")
      .map((line) => [...line].reduce((sum, c) => sum + charW(c), 0)),
  );
}

// 완료 여부: 물고기·요리·초밥 모두 Rank가 MAX면 완료.
function isDone(entry) {
  return getItem(entry).rank === "MAX";
}

// 물고기 이름 → 그 물고기를 재료로 쓰는 요리/초밥 목록. 한 번만 만들어 캐시.
let _fishDishIndex = null;
function getFishDishIndex() {
  if (_fishDishIndex) return _fishDishIndex;
  const nsp = (x) => String(x).replace(/\s+/g, "");
  const index = {};
  const add = (fishName, dish) => {
    (index[fishName] ||= []).push(dish);
  };
  const fishNames = [...new Set(FISH_DATA.map((f) => f.name))].sort(
    (a, b) => nsp(b).length - nsp(a).length,
  );
  const seahorses = fishNames.filter((n) => n.includes("해마"));
  const seadragons = fishNames.filter((n) => n.includes("해룡"));

  // 요리/초밥 하나를, 재료가 가리키는 물고기(들)에 연결.
  // 범용 "해마"/"해룡"은 모든 해마/해룡에 연결한다(예: 해마 꼬치구이).
  const addDish = (ref, dish) => {
    if (ref === "해마") seahorses.forEach((f) => add(f, dish));
    else if (ref === "해룡") seadragons.forEach((f) => add(f, dish));
    else add(ref, dish);
  };

  // 재료 한 줄 → 물고기 이름(또는 "해마"/"해룡"). 못 찾으면 null.
  const matchFish = (line) => {
    const name = line.replace(/\s*\d+$/, "").trim();
    if (name === "해마" || name === "해룡") return name;
    const n = nsp(name);
    // 보스 부위: "<보스명>의 <부위>" → 보스명이 물고기 이름과 같거나 그 끝에 포함
    // (예: 클라우스 → 백상아리 클라우스, 늑대장어 → 거대늑대장어)
    const poss = name.match(/^(.+?)의(?:\s|$)/);
    if (poss) {
      const owner = nsp(poss[1]);
      if (owner.length >= 2) {
        const f = fishNames.find((fn) => nsp(fn) === owner || nsp(fn).endsWith(owner));
        if (f) return f;
      }
    }
    // 일반: 물고기 이름이 재료의 접두어(부위명은 뒤에 붙음)
    return fishNames.find((fn) => nsp(fn).length >= 2 && n.startsWith(nsp(fn))) || null;
  };

  SUSHI_DATA.forEach((s) => {
    if (s.fish) addDish(s.fish, { name: s.name, icon: s.icon, tab: "sushi", area: s.area, key: getFishKey(s) });
  });
  COOK_DATA.forEach((c) => {
    const refs = new Set();
    String(c.ing)
      .split("\n")
      .forEach((line) => {
        const m = matchFish(line);
        if (m) refs.add(m);
      });
    const dish = { name: c.name, icon: c.icon, tab: "cook", area: c.area, key: getFishKey(c) };
    refs.forEach((ref) => addDish(ref, dish));
  });
  _fishDishIndex = index;
  return index;
}

function removeDishPanel() {
  const dd = $("app").querySelector(".dish-dropdown");
  if (dd) {
    const card = dd.closest(".card");
    if (card) card.classList.remove("dish-open");
    dd.remove();
  }
}

// 원 안에 ! 아이콘 + 호버 툴팁(참고 문구). 요리 해금조건 옆 등에 쓴다.
function noteBadge(text) {
  return (
    `<span class="also-badge" tabindex="0" aria-label="참고">` +
    `<svg class="also-ico" viewBox="0 0 20 20" aria-hidden="true">` +
    `<circle cx="10" cy="10" r="8.3" fill="none" stroke="currentColor" stroke-width="1.6"></circle>` +
    `<line x1="10" y1="5.4" x2="10" y2="11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></line>` +
    `<circle cx="10" cy="14.1" r="1.15" fill="currentColor"></circle>` +
    `</svg>` +
    `<span class="also-tip">${text}</span></span>`
  );
}

// 카드 아래 드롭다운을 붙인다. 물고기(포획)=요리/초밥 목록, 요리=해금조건·장인의 불꽃 정보.
function attachDishDropdown(key) {
  removeDishPanel();
  const card = Array.from($("app").querySelectorAll(".card")).find((c) => c.dataset.key === key);
  if (!card) return;
  const category = key.split("::")[0];

  const dd = document.createElement("div");
  dd.className = "dish-dropdown";
  dd.addEventListener("click", (event) => event.stopPropagation());

  if (category === "요리") {
    // 요리: 해금조건 + 필요 장인의 불꽃 (정보만, 상호작용 없음)
    const cook = COOK_DATA.find((c) => getFishKey(c) === key);
    if (!cook) return;
    dd.classList.add("dish-dropdown--info");
    const rows = [];
    const delay = () => `style="animation-delay:${(rows.length * 0.05).toFixed(3)}s"`;
    if (cook.unlock)
      rows.push(
        `<div class="info-row" ${delay()}><span class="info-label">해금</span>` +
          `<span class="info-val">${cook.unlock}${cook.note ? noteBadge(cook.note) : ""}</span></div>`,
      );
    if (cook.flame)
      rows.push(
        `<div class="info-row" ${delay()}><span class="info-label">장인의 불꽃</span>` +
          `<span class="info-val info-flame">🔥 ${cook.flame}</span></div>`,
      );
    dd.innerHTML = rows.join("") || '<div class="dish-empty">표시할 정보가 없습니다</div>';
  } else {
    // 물고기: 이 물고기로 만드는 요리/초밥 목록
    const fishName = key.split("::").pop();
    const dishes = getFishDishIndex()[fishName] || [];
    if (!dishes.length) {
      dd.innerHTML = '<div class="dish-empty">이 물고기를 재료로 쓰는 요리 · 초밥이 없습니다</div>';
    } else {
      dd.innerHTML = dishes
        .map((d, i) => {
          // 각 요리/초밥에 내가 설정한 랭크를 오른쪽에 함께 표시(읽기 전용). MAX면 색 강조.
          const item = state[d.key] || getDefaultItem();
          const isMax = item.rank === "MAX";
          return (
            `<button type="button" class="dish-chip" data-tab="${d.tab}" data-key="${d.key}" data-area="${d.area}" style="animation-delay:${(i * 0.04).toFixed(3)}s">` +
            `<span class="dish-chip-ico">${d.icon ? `<img src="${d.icon}" alt="">` : "?"}</span>` +
            `<span class="dish-chip-name">${d.name}</span>` +
            `<span class="dish-chip-rank${isMax ? " max" : ""}">Rank ${getRankLabel(item.rank)}</span></button>`
          );
        })
        .join("");
      dd.querySelectorAll(".dish-chip").forEach((chip) => {
        chip.addEventListener("click", (event) => {
          event.stopPropagation();
          navigateToDish(chip.dataset.tab, chip.dataset.key, chip.dataset.area);
        });
      });
    }
  }

  card.classList.add("dish-open");
  card.appendChild(dd);
}

function toggleDishPanel(fishKey) {
  if (openDishFishKey === fishKey) {
    openDishFishKey = null;
    removeDishPanel();
  } else {
    openDishFishKey = fishKey;
    attachDishDropdown(fishKey);
  }
}

// 요리/초밥 목록에서 항목 클릭 → 해당 탭으로 이동 + 스크롤 + 잠깐 점등.
function navigateToDish(tab, key, area) {
  openDishFishKey = null;
  if (area) collapsedAreas.delete(area); // 대상 섹션이 접혀 있으면 펼친다
  // 검색·필터가 걸려 있으면 대상이 가려질 수 있으니 초기화한다.
  filters.q = "";
  filters.area = "";
  filters.notMax = false;
  filters.party = "";
  const searchEl = $("search");
  if (searchEl) searchEl.value = "";
  $("notMaxOnly").classList.remove("active");
  removeDishPanel();
  setActiveTab(tab, false); // 리셋하지 않고 대상 위치로 직접 이동한다

  // 대상 카드를 화면 중앙으로 즉시 이동(상/하단 근처면 가능한 최대까지). 즉시 스크롤이라
  // 애니메이션 중단 없이 항상 정확히 도달한다.
  const scrollToTarget = () => {
    const card = Array.from($("app").querySelectorAll(".card")).find((c) => c.dataset.key === key);
    if (!card) return null;
    const rect = card.getBoundingClientRect();
    const mid = window.scrollY + rect.top + rect.height / 2 - window.innerHeight / 2;
    const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    window.scrollTo(0, Math.max(0, Math.min(maxY, mid)));
    stopWheelScroll(); // 관성 스크롤이 되돌리지 않도록 중단
    return card;
  };

  // 렌더 후 레이아웃이 안정된 다음(rAF 2번) 스크롤하고, 이미지 로드 등 늦은 변화도 한 번 더 보정.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const card = scrollToTarget();
      if (!card) return;
      card.classList.remove("flash");
      void card.offsetWidth; // 애니메이션 재시작용 리플로우
      card.classList.add("flash");
      setTimeout(() => card.classList.remove("flash"), 1600);
      setTimeout(scrollToTarget, 200); // 늦은 레이아웃 변화 보정
    }),
  );
}

// 추가 출현 정보의 시간대(낮/밤/항상)를 텍스트 대신 시간대 아이콘(색상 포함)으로 표시.
const ALSO_TIME_ICON = {
  낮: { icon: ACTIVE_TIME_META.day.icon, color: "#ffe5a0" },
  밤: { icon: ACTIVE_TIME_META.night.icon, color: "#d8e1ff" },
  항상: { icon: ACTIVE_TIME_META.always.icon, color: "#d8f8ff" },
};
function alsoTimeIcon(time) {
  const t = ALSO_TIME_ICON[time];
  if (!t) return time; // 모르는 값이면 원문 텍스트 유지
  return `<span class="also-time" style="color:${t.color}" aria-label="${time}">${t.icon}</span>`;
}

// 추가 출현 지역 배지: 원 안에 ! 아이콘(SVG). 호버/포커스 시 추가 지역·시간대를 알려준다.
// 여러 지역에 나오는 물고기를 지역마다 중복 카드로 넣지 않고 한 카드에 표기하기 위함.
function alsoInBadge(list) {
  const lines = list.map((a) => `<span>${a.area} · ${alsoTimeIcon(a.time)}</span>`).join("");
  return (
    `<span class="also-badge" tabindex="0" aria-label="추가 출현 지역">` +
    `<svg class="also-ico" viewBox="0 0 20 20" aria-hidden="true">` +
    `<circle cx="10" cy="10" r="8.3" fill="none" stroke="currentColor" stroke-width="1.6"></circle>` +
    `<line x1="10" y1="5.4" x2="10" y2="11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></line>` +
    `<circle cx="10" cy="14.1" r="1.15" fill="currentColor"></circle>` +
    `</svg>` +
    `<span class="also-tip" role="tooltip"><b>추가 출현</b>${lines}</span>` +
    `</span>`
  );
}

function getAreaLabel(value) {
  return value || "전체 지역";
}

function setAreaMenuOpen(open) {
  areaMenuOpen = open;
  $("areaFilterWrap").classList.toggle("open", open);
  $("areaFilterTrigger").setAttribute("aria-expanded", String(open));
}

function renderAreaMenu() {
  $("areaFilterTrigger").textContent = getAreaLabel(filters.area);
  $("areaFilterMenu").innerHTML = AREA_OPTIONS.map((value) => {
    const selected = value === filters.area;
    return `<button type="button" class="toolbar-select-option${selected ? " selected" : ""}" data-area-value="${value}" role="menuitemradio" aria-checked="${selected}">${getAreaLabel(value)}</button>`;
  }).join("");

  $("areaFilterMenu").querySelectorAll(".toolbar-select-option").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      filters.area = button.dataset.areaValue;
      setAreaMenuOpen(false);
      render();
    });
  });
}

// 랭크의 정렬 순서값. 낮은 랭크 → 높은 랭크(MAX) 순서.
function rankOrder(rank) {
  const i = RANKS.indexOf(normalizeRank(rank));
  return i === -1 ? 0 : i;
}

// 섹션 내부 목록을 현재 정렬 기준(sortBy)으로 정렬한다(원본은 건드리지 않고 새 배열 반환).
function sortSection(list) {
  const desc = sortBy.endsWith("-desc");
  const dir = desc ? -1 : 1;
  const byRank = sortBy.startsWith("rank");
  return list.slice().sort((a, b) => {
    if (byRank) {
      const diff = rankOrder(getItem(a).rank) - rankOrder(getItem(b).rank);
      if (diff !== 0) return diff * dir;
      // 랭크가 같으면 이름 오름차순으로 안정적으로 정렬한다.
      return a.name.localeCompare(b.name, "ko");
    }
    return a.name.localeCompare(b.name, "ko") * dir;
  });
}

function getSortLabel(value) {
  return (SORT_OPTIONS.find((o) => o.value === value) || SORT_OPTIONS[0]).label;
}

function setSortMenuOpen(open) {
  sortMenuOpen = open;
  $("sortWrap").classList.toggle("open", open);
  $("sortTrigger").setAttribute("aria-expanded", String(open));
}

function renderSortMenu() {
  $("sortTrigger").textContent = getSortLabel(sortBy);
  $("sortMenu").innerHTML = SORT_OPTIONS.map((opt) => {
    const selected = opt.value === sortBy;
    return `<button type="button" class="toolbar-select-option${selected ? " selected" : ""}" data-sort-value="${opt.value}" role="menuitemradio" aria-checked="${selected}">${opt.label}</button>`;
  }).join("");

  $("sortMenu").querySelectorAll(".toolbar-select-option").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      sortBy = button.dataset.sortValue;
      setSortMenuOpen(false);
      render();
    });
  });
}

function setResetModalOpen(open) {
  resetModalOpen = open;
  $("resetModal").hidden = !open;
  document.body.classList.toggle("modal-open", open);
  if (open) {
    // 현재 탭(페이지)에 맞춰 안내 문구와 초기화 항목 목록을 구성한다.
    $("resetDesc").textContent = `${TAB_NAMES[activeTab] || ""} 페이지의 아래 내용이 모두 초기화 됩니다`;
    $("resetList").innerHTML = (RESET_ITEMS[activeTab] || [])
      .map((label) => `<li>${label}</li>`)
      .join("");
  }
}

function setLoginModalOpen(open) {
  loginModalOpen = open;
  $("loginModal").hidden = !open;
  document.body.classList.toggle("modal-open", open);
  if (open) {
    renderSyncControls();
    updateSyncStatus("", "idle");
    $("syncKey").focus();
  }
}

function visibleFish() {
  return FISH_DATA.filter((fish) => {
    const item = getItem(fish);
    const searchable = `${fish.name} ${fish.eng} ${fish.area} ${fish.category}`.toLowerCase();
    if (filters.q && !searchable.includes(filters.q)) return false;
    if (filters.area && fish.area !== filters.area) return false;
    if (filters.notMax && item.rank === "MAX") return false;
    // 시간대 아이콘 필터: "낮"은 낮+항상만, "밤"은 밤+항상만 표시. "항상"은 어디서든 보인다.
    const time = fish.activeTime || "always";
    if (filters.activeTime === "day" && !(time === "day" || time === "always")) return false;
    if (filters.activeTime === "night" && !(time === "night" || time === "always")) return false;
    return true;
  });
}

function activeDataset() {
  if (activeTab === "sushi") return SUSHI_DATA;
  if (activeTab === "cook") return COOK_DATA;
  if (activeTab === "fish") return FISH_DATA;
  return [];
}

function renderSummary() {
  const dataset = activeDataset();
  const total = dataset.length;
  const done = dataset.filter(isDone).length;
  $("total").textContent = total;
  $("done").textContent = done;
  $("todo").textContent = total - done;
  $("rate").textContent = total ? `${Math.round((done / total) * 100)}%` : "0%";
}

// 펼침/접힘 속도를 픽셀당 시간으로 통일한다. 고정 시간(ms)을 쓰면 내용이 적은
// 섹션은 느려 보이고 많은 섹션은 빨라 보이므로, 이동 거리에 비례해 시간을 정한다.
const AREA_ANIM_SPEED = 1.6; // px/ms (클수록 전체적으로 빠름)
const AREA_ANIM_MIN_MS = 300; // 아주 짧은 섹션이 너무 순식간에 끝나지 않도록
const AREA_ANIM_MAX_MS = 520; // 아주 긴 섹션이 너무 늘어지지 않도록
const AREA_ANIM_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";

function areaAnimDuration(distancePx) {
  const ms = distancePx / AREA_ANIM_SPEED;
  return Math.min(AREA_ANIM_MAX_MS, Math.max(AREA_ANIM_MIN_MS, ms));
}

// height를 from → to로 애니메이션한 뒤, 끝나면 resting 값으로 고정한다.
// 애니메이션 중에는 overflow를 hidden으로 잘라내고, 끝난 뒤엔 restingOverflow로 되돌린다.
// (펼친 상태에서는 overflow visible이어야 카드의 Rank 드롭다운이 잘리지 않는다.)
// fill:forwards로 끝 값을 유지하다가 inline으로 옮기고 취소하여 깜빡임을 없앤다.
function animateAreaHeight(contentEl, from, to, resting, restingOverflow, onDone) {
  contentEl.getAnimations().forEach((anim) => anim.cancel());
  contentEl.style.overflow = "hidden";
  const anim = contentEl.animate(
    [{ height: from }, { height: to }],
    { duration: areaAnimDuration(contentEl.scrollHeight), easing: AREA_ANIM_EASING, fill: "forwards" },
  );
  anim.onfinish = () => {
    contentEl.style.height = resting;
    contentEl.style.overflow = restingOverflow;
    anim.cancel();
    onDone?.();
  };
}

function toggleArea(area, contentEl) {
  const full = `${contentEl.scrollHeight}px`;
  const details = contentEl.closest("details");
  if (collapsedAreas.has(area)) {
    collapsedAreas.delete(area);
    // 펼침: 패딩을 먼저 18px로 되돌린 뒤 높이만 애니메이션 → 카드가 최종 위치에 나타나 흔들리지 않음
    details?.classList.remove("collapsed");
    animateAreaHeight(contentEl, "0px", full, "", ""); // 펼침: auto 높이 + overflow visible
  } else {
    collapsedAreas.add(area);
    // 접힘: 접히는 동안 패딩 18px 유지, 애니메이션이 끝나(카드가 안 보일 때) 10px로 줄임
    animateAreaHeight(contentEl, full, "0px", "0px", "hidden", () =>
      details?.classList.add("collapsed"),
    ); // 접힘
  }
}

function setActiveTab(tab, scrollTop = true) {
  if (activeTab === tab) return;
  activeTab = tab;
  openDishFishKey = null; // 탭을 바꾸면 열려 있던 드롭다운은 닫는다
  document.querySelectorAll(".side-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  render();
  // 스크롤은 문서 전체가 공유되므로 탭을 바꾸면 최상단에서 시작한다.
  // (단, 특정 요리로 바로 이동할 때는 리셋 없이 대상으로 스크롤한다)
  if (scrollTop) {
    window.scrollTo(0, 0);
    stopWheelScroll(); // 관성 스크롤이 되돌리지 않도록 중단
  }
}

// 요리/초밥 탭: 실데이터 전까지 카드 레이아웃(랭크만 + 재료 자리)만 보여주는 스켈레톤.
function renderPlaceholderTab() {
  const app = $("app");
  const SECTIONS = 2;
  const CARDS = 8;

  const card =
    '<article class="card card--recipe card--placeholder">' +
    '<div class="icon skeleton-box"></div>' +
    '<div class="card-body">' +
    '<div class="name skeleton-line"></div>' +
    '<div class="recipe-ingredients">' +
    '<span class="ing-line skeleton-line"></span>' +
    '<span class="ing-line skeleton-line"></span>' +
    '<span class="ing-line skeleton-line"></span>' +
    "</div>" +
    '<div class="row">' +
    '<span class="rank-control"><button type="button" class="rank-trigger" tabindex="-1">Rank 1</button></span>' +
    "</div>" +
    "</div>" +
    "</article>";

  let html = "";
  for (let s = 0; s < SECTIONS; s++) {
    html +=
      '<section class="area"><details open>' +
      '<summary><span><span class="skeleton-line" style="width:180px;height:20px;display:inline-block"></span></span></summary>' +
      '<div class="area-content"><div class="grid">' +
      card.repeat(CARDS) +
      "</div></div></details></section>";
  }
  app.innerHTML = html;
}

function visibleRecipe(data, applyArea) {
  return data.filter((r) => {
    const item = getItem(r);
    const party = Array.isArray(r.party) ? r.party : [];
    const searchable = `${r.name} ${r.ing} ${r.area} ${party.join(" ")}`.toLowerCase();
    if (filters.q && !searchable.includes(filters.q)) return false;
    if (applyArea && filters.area && r.area !== filters.area) return false;
    if (filters.notMax && item.rank === "MAX") return false;
    if (filters.party && !party.includes(filters.party)) return false;
    return true;
  });
}

// 초밥/요리 공용 탭 렌더: 섹션(area)별로 묶어 렌더. 카드는 이미지 + 이름 + 재료 + 랭크만
// (밤/낮·아쿠아·보스 없음). 재료는 줄바꿈(\n)으로 나뉜 여러 항목을 각 줄로 표시한다
// (초밥은 보통 1줄, 요리는 여러 줄). 상태/랭크/동기화는 물고기와 같은 저장소를 공유한다.
// applyArea=true면 상단 지역 필터를 적용(초밥은 섹션이 물고기 지역과 같아 유효).
function renderRecipeTab(data, emptyMsg, applyArea, modClass) {
  const app = $("app");
  const visible = visibleRecipe(data, applyArea);
  if (!visible.length) {
    app.innerHTML = `<div class="empty">${emptyMsg}</div>`;
    return;
  }

  const byArea = {};
  visible.forEach((r) => {
    (byArea[r.area] ||= []).push(r);
  });

  Object.entries(byArea).forEach(([area, unsortedList]) => {
    const list = sortSection(unsortedList);
    const section = document.createElement("section");
    section.className = "area";

    const areaDone = list.filter(isDone).length;
    const collapsed = collapsedAreas.has(area);
    section.innerHTML = `<details open${collapsed ? ' class="collapsed"' : ""}><summary><span>${area}</span><b>${areaDone} / ${list.length}</b></summary><div class="area-content"${collapsed ? ' style="height:0px;overflow:hidden"' : ""}><div class="grid grid--recipe"></div></div></details>`;

    const grid = section.querySelector(".grid");
    const areaContent = section.querySelector(".area-content");

    section.querySelector("summary").addEventListener("click", (event) => {
      event.preventDefault();
      toggleArea(area, areaContent);
    });

    list.forEach((r) => {
      const item = getItem(r);
      const itemKey = getFishKey(r);
      const isRankOpen = openRankKey === itemKey;
      const isMaxRank = item.rank === "MAX";

      const card = document.createElement("article");
      card.className =
        "card card--recipe" +
        (modClass ? " " + modClass : "") +
        (ingMaxWidth(r.ing) > 112 ? " card--wide" : "") +
        (isDone(r) ? " done" : "") +
        (isRankOpen ? " rank-open" : "");
      card.dataset.key = itemKey;

      const rankOptions = RANKS.map((rank) => {
        const selected = String(item.rank) === rank ? "selected" : "";
        return `<button type="button" class="rank-option ${selected}" data-rank="${rank}" role="menuitem">${getRankLabel(rank)}</button>`;
      }).join("");

      const ingLines = String(r.ing)
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          // 끝의 수량 숫자만 따로 감싸 강조(색/굵기)해서 가시성을 높인다.
          const disp = line.replace(/\s(\d+)$/, ' <span class="ing-qty">$1</span>');
          return `<span class="ing-line">${disp}</span>`;
        })
        .join("");

      card.innerHTML =
        `<div class="icon">${r.icon ? `<img src="${r.icon}" alt="">` : "?"}</div>` +
        `<div class="card-body">` +
        `<div class="name">${r.name}</div>` +
        `<div class="recipe-ingredients">${ingLines}</div>` +
        `<div class="row">` +
        `<span class="rank-control ${isRankOpen ? "open" : ""} ${isMaxRank ? "max" : ""}">` +
        `<button type="button" class="rank-trigger" aria-haspopup="menu" aria-expanded="${isRankOpen}" aria-label="${r.name} 랭크 ${item.rank}">Rank ${getRankLabel(item.rank)}</button>` +
        `${isRankOpen ? `<span class="rank-menu" role="menu">${rankOptions}</span>` : ""}` +
        `</span>` +
        partyBadges(r.party) +
        `</div></div>`;

      // 완료는 랭크 MAX로만 정해진다(카드 클릭 체크 없음).
      // 요리 카드는 클릭하면 해금조건·장인의 불꽃 정보를 아래에 펼친다(정보만).
      if (r.category === "요리") {
        card.addEventListener("click", () => toggleDishPanel(itemKey));
        card.addEventListener("keydown", (event) => {
          if (event.target.closest(".rank-control")) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          toggleDishPanel(itemKey);
        });
      }

      const rankControl = card.querySelector(".rank-control");
      rankControl.addEventListener("click", (event) => event.stopPropagation());
      rankControl.querySelector(".rank-trigger").addEventListener("click", () => {
        openDishFishKey = null; // 랭크 메뉴를 열 때 요리 목록/정보 드롭다운은 닫아 겹침 방지
        openRankKey = isRankOpen ? null : itemKey;
        render();
      });

      rankControl.querySelectorAll(".rank-option").forEach((option) => {
        option.addEventListener("click", () => {
          openRankKey = null;
          setItem(r, { rank: option.dataset.rank });
        });
      });

      // 파티 태그 클릭: 그 태그를 가진 것만 필터. 다시 누르면 해제(낮/밤 배지와 동일).
      card.querySelectorAll(".party-filter").forEach((btn) => {
        btn.addEventListener("click", (event) => {
          event.stopPropagation(); // 카드 클릭(요리 정보 펼치기) 방지
          filters.party = filters.party === btn.dataset.party ? "" : btn.dataset.party;
          render();
        });
      });

      grid.appendChild(card);
    });

    app.appendChild(section);
  });

  // 열려 있던 요리 정보 드롭다운을 다시 붙인다(랭크 변경 등으로 재렌더돼도 유지).
  if (openDishFishKey) attachDishDropdown(openDishFishKey);
}

function render() {
  renderSummary();
  renderAreaMenu();
  renderSortMenu();

  const app = $("app");
  app.innerHTML = "";

  if (activeTab === "sushi") {
    renderRecipeTab(SUSHI_DATA, "표시할 초밥이 없습니다", true, "");
    return;
  }
  if (activeTab === "cook") {
    renderRecipeTab(COOK_DATA, "표시할 요리가 없습니다", false, "card--cook");
    return;
  }
  if (activeTab !== "fish") {
    renderPlaceholderTab();
    return;
  }

  const data = visibleFish();
  if (!data.length) {
    app.innerHTML = '<div class="empty">표시할 물고기가 없습니다</div>';
    return;
  }

  const byArea = {};
  data.forEach((fish) => {
    (byArea[fish.area] ||= []).push(fish);
  });

  Object.entries(byArea).forEach(([area, unsortedList]) => {
    // 섹션 순서는 원본(FISH_DATA) 순서를 유지하고, 섹션 안 물고기만 현재 정렬 기준으로 정렬한다.
    const list = sortSection(unsortedList);

    const section = document.createElement("section");
    section.className = "area";

    const areaDone = list.filter(isDone).length;
    const collapsed = collapsedAreas.has(area);
    section.innerHTML = `<details open${collapsed ? ' class="collapsed"' : ""}><summary><span>${area}</span><b>${areaDone} / ${list.length}</b></summary><div class="area-content"${collapsed ? ' style="height:0px;overflow:hidden"' : ""}><div class="grid"></div></div></details>`;

    const grid = section.querySelector(".grid");
    const areaContent = section.querySelector(".area-content");

    // 네이티브 details 토글을 막고 우리가 높이 애니메이션으로 직접 접고 편다.
    section.querySelector("summary").addEventListener("click", (event) => {
      event.preventDefault();
      toggleArea(area, areaContent);
    });

    list.forEach((fish) => {
      const item = getItem(fish);
      const itemKey = getFishKey(fish);
      const isRankOpen = openRankKey === itemKey;
      const isMaxRank = item.rank === "MAX";
      const isBoss = fish.rank === "99";
      const isTank = Boolean(item.tank);
      // 해마·해룡은 수족관에 넣을 수 없으므로 Aqua 버튼을 표시하지 않는다.
      const noAqua = fish.name.includes("해마") || fish.name.includes("해룡");
      const timeKey = fish.activeTime || "always";
      const activeTime = ACTIVE_TIME_META[timeKey] || ACTIVE_TIME_META.always;
      // 낮·밤 배지는 클릭 필터로 동작한다. 항상 배지는 상호작용이 없다.
      const timeFilterable = timeKey === "day" || timeKey === "night";
      const timeFilterActive = filters.activeTime === timeKey;

      const card = document.createElement("article");
      card.className =
        "card" +
        (isDone(fish) ? " done" : "") +
        (isRankOpen ? " rank-open" : "") +
        (openDishFishKey === itemKey ? " dish-open" : "");
      card.tabIndex = 0;
      card.dataset.key = itemKey;
      card.setAttribute("role", "button");
      card.setAttribute("aria-expanded", String(openDishFishKey === itemKey));

      const rankOptions = RANKS.map((rank) => {
        const selected = String(item.rank) === rank ? "selected" : "";
        return `<button type="button" class="rank-option ${selected}" data-rank="${rank}" role="menuitem">${getRankLabel(rank)}</button>`;
      }).join("");

      card.innerHTML =
        `<div class="icon">${fish.icon ? `<img src="${fish.icon}" alt="">` : "?"}</div>` +
        `<div class="card-body">` +
        (timeFilterable
          ? `<button type="button" class="time-badge time-${timeKey} time-filter${timeFilterActive ? " active" : ""}" aria-pressed="${timeFilterActive}" aria-label="${activeTime.label} 물고기만 보기">${activeTime.icon}</button>`
          : `<span class="time-badge time-${timeKey}" aria-label="${activeTime.label}">${activeTime.icon}</span>`) +
        `<div class="name">${fish.name}</div>` +
        `<div class="eng">${fish.eng}</div>` +
        `<div class="row">` +
        `<span class="rank-control ${isRankOpen ? "open" : ""} ${isMaxRank ? "max" : ""}">` +
        `<button type="button" class="rank-trigger" aria-haspopup="menu" aria-expanded="${isRankOpen}" aria-label="${fish.name} 랭크 ${item.rank}">Rank ${getRankLabel(item.rank)}</button>` +
        `${isRankOpen ? `<span class="rank-menu" role="menu">${rankOptions}</span>` : ""}` +
        `</span>` +
        (isBoss || noAqua
          ? ""
          : `<button type="button" class="tank-toggle ${isTank ? "active" : ""}" aria-pressed="${isTank}" aria-label="${isTank ? "수족관 등록됨" : "수족관 등록 안 됨"}">` +
            `<span class="tank-toggle-dot"></span><span class="tank-toggle-text">Aqua</span></button>`) +
        `${isBoss ? '<span class="boss-badge">Boss</span>' : ""}` +
        `${fish.alsoIn && fish.alsoIn.length ? alsoInBadge(fish.alsoIn) : ""}` +
        `</div></div>`;

      // 카드 클릭 = 이 물고기로 만드는 요리/초밥 목록을 아래에 펼치기/접기.
      // (완료 여부는 Rank MAX로 자동 결정되므로 클릭으로 체크하지 않는다.)
      card.addEventListener("click", () => toggleDishPanel(itemKey));
      card.addEventListener("keydown", (event) => {
        if (event.target.closest(".rank-control") || event.target.closest(".tank-toggle") || event.target.closest(".time-filter") || event.target.closest(".also-badge")) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toggleDishPanel(itemKey);
      });

      const rankControl = card.querySelector(".rank-control");
      rankControl.addEventListener("click", (event) => event.stopPropagation());
      rankControl.querySelector(".rank-trigger").addEventListener("click", () => {
        openDishFishKey = null; // 랭크 메뉴를 열 때 요리 목록/정보 드롭다운은 닫아 겹침 방지
        openRankKey = isRankOpen ? null : itemKey;
        render();
      });

      rankControl.querySelectorAll(".rank-option").forEach((option) => {
        option.addEventListener("click", () => {
          openRankKey = null;
          setItem(fish, { rank: option.dataset.rank });
        });
      });

      const tankToggle = card.querySelector(".tank-toggle");
      if (tankToggle) {
        tankToggle.addEventListener("click", (event) => {
          event.stopPropagation();
          setItem(fish, { tank: !isTank });
        });
      }

      // 낮·밤 배지 클릭: 같은 시간대 필터를 켜고, 다시 누르면 해제한다.
      const timeBadge = card.querySelector(".time-filter");
      if (timeBadge) {
        timeBadge.addEventListener("click", (event) => {
          event.stopPropagation();
          filters.activeTime = filters.activeTime === timeKey ? "" : timeKey;
          render();
        });
      }

      // 추가 출현 배지는 정보 표시용이라 카드 체크 토글을 막는다.
      const alsoBadge = card.querySelector(".also-badge");
      if (alsoBadge) alsoBadge.addEventListener("click", (event) => event.stopPropagation());

      grid.appendChild(card);
    });

    app.appendChild(section);
  });

  // 열려 있던 요리 목록 드롭다운을 다시 붙인다(랭크 변경 등으로 재렌더돼도 유지).
  if (openDishFishKey) attachDishDropdown(openDishFishKey);
}

function getSyncDocId(syncKey) {
  return syncKey.trim().replace(/[/.#$[\]]+/g, "-");
}

function getStateHash(payload) {
  return JSON.stringify(payload);
}

function updateSyncStatus(message, tone = "idle") {
  const status = $("syncStatus");
  status.textContent = message;
  status.dataset.tone = tone;
}

function renderSyncControls() {
  $("syncKey").value = sync.key;
  $("syncConnectBtn").disabled = sync.connecting;

  // 상단 버튼: 로그인 상태면 "로그아웃"(붉은 배경), 아니면 "로그인"(파란 배경)으로 토글.
  const authBtn = $("authBtn");
  authBtn.textContent = sync.connected ? "로그아웃" : "로그인";
  authBtn.classList.toggle("logged-in", sync.connected);
  authBtn.disabled = sync.connecting;
}

function getFirebaseDb() {
  if (!isFirebaseConfigured()) return null;

  if (!sync.app) {
    sync.app = getApps()[0] || initializeApp(firebaseConfig);
    sync.db = getFirestore(sync.app);
  }

  return sync.db;
}

async function connectSync() {
  const inputKey = $("syncKey").value.trim();
  sync.key = inputKey;
  localStorage.setItem(SYNC_KEY_STORAGE, inputKey);
  renderSyncControls();

  if (!inputKey) {
    updateSyncStatus("ID를 입력해 주세요", "warn");
    return;
  }

  if (!isFirebaseConfigured()) {
    updateSyncStatus("firebase-config.js 설정이 필요합니다", "warn");
    return;
  }

  const db = getFirebaseDb();
  if (!db) {
    updateSyncStatus("Firebase 초기화에 실패했습니다", "error");
    return;
  }

  disconnectSync({ silent: true });
  sync.connecting = true;
  renderSyncControls();
  updateSyncStatus("로그인 중...", "idle");

  const docRef = doc(db, "checklists", getSyncDocId(inputKey));
  sync.docRef = docRef;

  try {
    const snapshot = await getDoc(docRef);
    const remoteData = snapshot.exists() ? snapshot.data() : null;
    const remoteState = normalizeState(remoteData?.state);
    const remoteModifiedAt = Number(remoteData?.modifiedAt) || 0;

    // 현재 로컬 state가 지금 연결하려는 키의 데이터인지 판별.
    // 같은 키일 때만 타임스탬프 병합(오프라인 편집 반영)이 의미가 있다.
    const sameKeyAsLocal = stateOwnerKey === inputKey;

    if (remoteData) {
      // 자가 복구 안전장치: 로컬은 비었는데(버그·저장소 손상 등) 원격엔 실제 데이터가 있으면,
      // 타임스탬프와 무관하게 원격을 채택해 진행 기록을 되살린다.
      const localEmpty = Object.keys(state).length === 0;
      const remoteEmpty = Object.keys(remoteState).length === 0;
      const localBrokenEmpty = localEmpty && !remoteEmpty;

      // 원격 문서 존재: 같은 키로 재연결이고 로컬이 더 최신일 때만 로컬을 푸시하고,
      // 그 외(다른 키로 전환, 또는 위의 로컬 손상 상황)에는 원격 데이터를 그대로 채택한다.
      if (sameKeyAsLocal && stateModifiedAt > remoteModifiedAt && !localBrokenEmpty) {
        stateOwnerKey = inputKey;
        await pushStateToRemote();
      } else {
        state = remoteState;
        stateModifiedAt = remoteModifiedAt;
        stateOwnerKey = inputKey;
        saveLocalStore();
        render();
      }
    } else if (stateOwnerKey === "" || sameKeyAsLocal) {
      // 원격 문서 없음 + (아직 어떤 키에도 속하지 않은 로컬 전용 상태 이거나, 같은 키의 원격이 사라진 경우)
      // → 현재 진행도로 이 키를 시드/복구한다.
      stateOwnerKey = inputKey;
      await pushStateToRemote();
    } else {
      // 원격 문서 없음 + 다른 키에 속한 로컬 상태 → 새 키는 빈 상태로 시작한다.
      // (이전 키의 데이터를 새 키에 밀어넣지 않는다.)
      state = {};
      stateOwnerKey = inputKey;
      touchState();
      saveLocalStore();
      render();
      await pushStateToRemote();
    }

    sync.unsubscribe = onSnapshot(
      docRef,
      (liveSnapshot) => {
        if (!liveSnapshot.exists()) return;

        const payload = {
          state: normalizeState(liveSnapshot.data().state),
          modifiedAt: Number(liveSnapshot.data().modifiedAt) || 0,
        };
        const hash = getStateHash(payload);
        if (hash === sync.lastRemoteHash) return;

        sync.lastRemoteHash = hash;
        if (payload.modifiedAt > stateModifiedAt) {
          state = payload.state;
          stateModifiedAt = payload.modifiedAt;
          saveLocalStore();
          render();
        }

        sync.connected = true;
        sync.connecting = false;
        renderSyncControls();
        updateSyncStatus(`로그인됨: ${sync.key}`, "ok");
      },
      () => {
        sync.connecting = false;
        sync.connected = false;
        renderSyncControls();
        updateSyncStatus("연결 오류", "error");
      },
    );

    sync.connected = true;
    sync.connecting = false;
    renderSyncControls();
    updateSyncStatus(`로그인됨: ${sync.key}`, "ok");
    setLoginModalOpen(false);
  } catch {
    sync.connecting = false;
    sync.connected = false;
    sync.docRef = null;
    renderSyncControls();
    updateSyncStatus("로그인 실패", "error");
  }
}

function disconnectSync({ silent = false } = {}) {
  if (sync.unsubscribe) {
    sync.unsubscribe();
    sync.unsubscribe = null;
  }
  if (sync.saveTimer) {
    clearTimeout(sync.saveTimer);
    sync.saveTimer = null;
  }
  sync.connected = false;
  sync.connecting = false;
  sync.docRef = null;
  sync.lastRemoteHash = "";
  renderSyncControls();
  if (!silent) {
    updateSyncStatus("", "idle");
  }
}

// 사용자가 직접 로그아웃: 저장된 ID를 지워 다음 방문 때 자동 로그인되지 않게 한다.
// (로컬 진행 기록 자체는 유지된다.)
function logout() {
  sync.key = "";
  localStorage.removeItem(SYNC_KEY_STORAGE);
  disconnectSync();
}

async function pushStateToRemote() {
  if (!sync.docRef) return;

  // 🛡️ 데이터 유실 방지 안전장치:
  // 로컬 state가 비어 있는데(버그·사고 등) 원격에는 실제 진행 데이터가 있다면,
  // 사용자가 직접 초기화한 경우가 아닌 한 원격을 덮어쓰지 않는다.
  // (이 가드가 없으면 빈 {} 하나가 모든 기기의 데이터를 지워버릴 수 있다.)
  if (Object.keys(state).length === 0 && !allowEmptyRemotePush) {
    try {
      const remoteSnap = await getDoc(sync.docRef);
      const remoteState = remoteSnap.exists() ? normalizeState(remoteSnap.data()?.state) : {};
      if (Object.keys(remoteState).length > 0) {
        updateSyncStatus("안전장치: 빈 상태로 원격 데이터를 덮어쓰지 않았습니다", "warn");
        return;
      }
    } catch {
      // 원격 상태를 확인하지 못하면 위험하므로 푸시를 보류한다.
      return;
    }
  }

  const payload = {
    state,
    modifiedAt: stateModifiedAt,
  };

  sync.lastRemoteHash = getStateHash(payload);
  allowEmptyRemotePush = false;

  await setDoc(
    sync.docRef,
    {
      ...payload,
      updatedAtIso: new Date(stateModifiedAt).toISOString(),
    },
    { merge: true },
  );
}

function scheduleRemoteSave() {
  if (!sync.connected || !sync.docRef) return;

  if (sync.saveTimer) clearTimeout(sync.saveTimer);
  sync.saveTimer = setTimeout(() => {
    pushStateToRemote().catch(() => {
      updateSyncStatus("저장 실패", "error");
    });
  }, 180);
}

function initFilters() {
  renderAreaMenu();
  renderSortMenu();
  renderSyncControls();

  document.querySelectorAll(".side-tab").forEach((btn) => {
    btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
  });

  $("search").addEventListener("input", (event) => {
    filters.q = event.target.value.trim().toLowerCase();
    render();
  });

  $("areaFilterTrigger").addEventListener("click", (event) => {
    event.stopPropagation();
    setAreaMenuOpen(!areaMenuOpen);
  });

  $("areaFilterMenu").addEventListener("click", (event) => event.stopPropagation());

  $("sortTrigger").addEventListener("click", (event) => {
    event.stopPropagation();
    setSortMenuOpen(!sortMenuOpen);
  });

  $("sortMenu").addEventListener("click", (event) => event.stopPropagation());

  $("notMaxOnly").addEventListener("click", () => {
    filters.notMax = !filters.notMax;
    $("notMaxOnly").classList.toggle("active", filters.notMax);
    render();
  });

  $("resetBtn").addEventListener("click", () => {
    setResetModalOpen(true);
  });

  $("resetCancelBtn").addEventListener("click", () => {
    setResetModalOpen(false);
  });

  $("resetConfirmBtn").addEventListener("click", () => {
    resetState();
    setResetModalOpen(false);
    render();
  });

  $("resetModal").addEventListener("click", (event) => {
    if (event.target.dataset.closeReset) {
      setResetModalOpen(false);
    }
  });

  // 상단 버튼: 로그인 상태면 로그아웃, 아니면 로그인 모달을 연다.
  $("authBtn").addEventListener("click", () => {
    if (sync.connected) {
      logout();
    } else {
      setLoginModalOpen(true);
    }
  });

  $("loginCancelBtn").addEventListener("click", () => {
    setLoginModalOpen(false);
  });

  $("loginModal").addEventListener("click", (event) => {
    if (event.target.dataset.closeLogin) {
      setLoginModalOpen(false);
    }
  });

  $("syncConnectBtn").addEventListener("click", () => {
    connectSync();
  });

  $("syncKey").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      connectSync();
    }
  });
}

document.addEventListener("click", (event) => {
  if (openRankKey) {
    openRankKey = null;
    render();
    return;
  }
  if (areaMenuOpen) {
    setAreaMenuOpen(false);
  }
  if (sortMenuOpen) {
    setSortMenuOpen(false);
  }
  // 카드 바깥을 클릭하면 요리 목록 드롭다운을 닫는다.
  if (openDishFishKey && !event.target.closest(".card")) {
    openDishFishKey = null;
    removeDishPanel();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;

  if (openRankKey) {
    openRankKey = null;
    render();
    return;
  }
  if (areaMenuOpen) {
    setAreaMenuOpen(false);
    return;
  }
  if (sortMenuOpen) {
    setSortMenuOpen(false);
    return;
  }
  if (resetModalOpen) {
    setResetModalOpen(false);
    return;
  }
  if (loginModalOpen) {
    setLoginModalOpen(false);
  }
});

initFilters();
render();

if (sync.key) {
  updateSyncStatus("저장된 ID로 로그인 중...", "idle");
  connectSync();
} else if (!isFirebaseConfigured()) {
  updateSyncStatus("firebase-config.js 설정 후 로그인 가능", "warn");
}

// 마우스 휠 스크롤을 부드럽게(관성 느낌). 트랙패드·확대(ctrl)·줄 단위 휠·
// 내부 스크롤 영역(요리 목록 드롭다운)·모달·모션 최소화 설정은 기본 동작을 유지한다.
(function smoothWheelScroll() {
  const EASE = 0.12; // 클수록 빠르게 따라붙음(작을수록 더 부드럽고 느림)
  let target = window.scrollY;
  let raf = null;

  const maxScroll = () =>
    Math.max(0, document.documentElement.scrollHeight - window.innerHeight);

  function step() {
    const cur = window.scrollY;
    const diff = target - cur;
    // 1px 이내면 목표로 딱 붙인다(브라우저가 스크롤 위치를 정수 픽셀로 반올림해도 끝까지 도달).
    if (Math.abs(diff) <= 1) {
      window.scrollTo(0, target);
      raf = null;
      return;
    }
    // 남은 거리의 EASE 비율만큼, 단 최소 1px은 이동한다. 목표 근처에서 이동량이 0.5px 밑으로
    // 떨어지면 반올림에 먹혀 몇 px 못 미친 채 멈추던 문제를 막는다.
    const stepAmt = Math.sign(diff) * Math.max(1, Math.abs(diff) * EASE);
    window.scrollTo(0, cur + stepAmt);
    raf = requestAnimationFrame(step);
  }

  // 프로그램적 스크롤(탭 전환/대상 이동) 시 호출: 관성 애니메이션을 멈추고
  // 목표를 현재 위치로 동기화해 되돌림을 막는다.
  stopWheelScroll = () => {
    if (raf !== null) {
      cancelAnimationFrame(raf);
      raf = null;
    }
    target = window.scrollY;
  };

  window.addEventListener(
    "wheel",
    (event) => {
      if (event.ctrlKey) return; // 확대(ctrl+휠)는 기본
      if (document.body.classList.contains("modal-open")) return; // 모달 열림 시 기본
      if (event.target.closest(".dish-dropdown")) return; // 자체 스크롤 영역
      if (maxScroll() <= 0) return; // 스크롤할 게 없으면 기본

      // 델타 단위 환산: 0=픽셀, 1=줄(마우스에서 흔함), 2=페이지
      let dy = event.deltaY;
      if (event.deltaMode === 1) dy *= 40;
      else if (event.deltaMode === 2) dy *= window.innerHeight;
      if (!dy) return;

      event.preventDefault();
      if (raf === null) target = window.scrollY; // 멈춰 있었으면 현재 위치로 동기화
      target = Math.max(0, Math.min(maxScroll(), target + dy));
      if (raf === null) raf = requestAnimationFrame(step);
    },
    { passive: false },
  );
})();
