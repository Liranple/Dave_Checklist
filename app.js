import { initializeApp, getApps } from "firebase/app";
import { doc, getDoc, getFirestore, onSnapshot, setDoc } from "firebase/firestore";
import { firebaseConfig, isFirebaseConfigured } from "./firebase-config.js";

const FISH_DATA = window.FISH_DATA || [];
const RANKS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "MAX"];
const STORE_KEY = "dave_checklist_v2";
const SYNC_KEY_STORAGE = "dave_checklist_sync_key";

const ACTIVE_TIME_META = {
  day: { icon: "\u2600", label: "낮" },
  night: { icon: "\u263D", label: "밤" },
  always: { icon: "\u25CC", label: "항상" },
};

const AREA_ALL_VALUE = "";
const AREA_OPTIONS = [AREA_ALL_VALUE, ...new Set(FISH_DATA.map((fish) => fish.area))];

const localStore = loadLocalStore();

let state = localStore.state;
let stateModifiedAt = localStore.modifiedAt;
// 현재 로컬 state가 어느 Sync Key에 속한 데이터인지 추적 (""=로컬 전용, 아직 동기화 안 됨).
// 키를 바꿔 연결할 때 서로 다른 키의 데이터가 섞이는 것을 막는 데 사용.
let stateOwnerKey = localStore.ownerKey;
let filters = { q: "", area: "", todo: false, notMax: false };
let openRankKey = null;
let areaMenuOpen = false;
let resetModalOpen = false;

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

function getDefaultItem(fish) {
  return {
    checked: false,
    rank: fish.rank === "99" ? "9" : fish.rank,
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

function resetState() {
  state = {};
  persistState({ renderAfter: false });
}

function getRankLabel(rank) {
  return rank === "MAX" ? "M" : rank;
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

function setResetModalOpen(open) {
  resetModalOpen = open;
  $("resetModal").hidden = !open;
  document.body.classList.toggle("modal-open", open);
}

function visibleFish() {
  return FISH_DATA.filter((fish) => {
    const item = getItem(fish);
    const searchable = `${fish.name} ${fish.eng} ${fish.area} ${fish.category}`.toLowerCase();
    if (filters.q && !searchable.includes(filters.q)) return false;
    if (filters.area && fish.area !== filters.area) return false;
    if (filters.todo && item.checked) return false;
    if (filters.notMax && item.rank === "MAX") return false;
    return true;
  });
}

function renderSummary() {
  const total = FISH_DATA.length;
  const done = FISH_DATA.filter((fish) => getItem(fish).checked).length;
  $("total").textContent = total;
  $("done").textContent = done;
  $("todo").textContent = total - done;
  $("rate").textContent = total ? `${Math.round((done / total) * 100)}%` : "0%";
}

function render() {
  renderSummary();
  renderAreaMenu();

  const app = $("app");
  app.innerHTML = "";

  const data = visibleFish();
  if (!data.length) {
    app.innerHTML = '<div class="empty">표시할 물고기가 없습니다.</div>';
    return;
  }

  const byArea = {};
  data.forEach((fish) => {
    (byArea[fish.area] ||= []).push(fish);
  });

  Object.entries(byArea).forEach(([area, list]) => {
    const section = document.createElement("section");
    section.className = "area";

    const areaDone = list.filter((fish) => getItem(fish).checked).length;
    section.innerHTML = `<details open><summary><span>${area}</span><b>${areaDone} / ${list.length}</b></summary><div class="grid"></div></details>`;

    const grid = section.querySelector(".grid");

    list.forEach((fish) => {
      const item = getItem(fish);
      const itemKey = getFishKey(fish);
      const isRankOpen = openRankKey === itemKey;
      const isMaxRank = item.rank === "MAX";
      const isBoss = fish.rank === "99";
      const isTank = Boolean(item.tank);
      const activeTime = ACTIVE_TIME_META[fish.activeTime] || ACTIVE_TIME_META.always;

      const card = document.createElement("article");
      card.className =
        "card" + (item.checked ? " done" : "") + (isRankOpen ? " rank-open" : "");
      card.tabIndex = 0;
      card.setAttribute("role", "checkbox");
      card.setAttribute("aria-checked", String(item.checked));

      const rankOptions = RANKS.map((rank) => {
        const selected = String(item.rank) === rank ? "selected" : "";
        return `<button type="button" class="rank-option ${selected}" data-rank="${rank}" role="menuitem">${getRankLabel(rank)}</button>`;
      }).join("");

      card.innerHTML =
        `<div class="icon">${fish.icon ? `<img src="${fish.icon}" alt="">` : "?"}</div>` +
        `<div class="card-body">` +
        `<span class="time-badge time-${fish.activeTime || "always"}" aria-label="${activeTime.label}">${activeTime.icon}</span>` +
        `<div class="name">${fish.name}</div>` +
        `<div class="eng">${fish.eng}</div>` +
        `<div class="row">` +
        `<span class="rank-control ${isRankOpen ? "open" : ""} ${isMaxRank ? "max" : ""}">` +
        `<button type="button" class="rank-trigger" aria-haspopup="menu" aria-expanded="${isRankOpen}" aria-label="${fish.name} 랭크 ${item.rank}">Rank ${getRankLabel(item.rank)}</button>` +
        `${isRankOpen ? `<span class="rank-menu" role="menu">${rankOptions}</span>` : ""}` +
        `</span>` +
        `<button type="button" class="tank-toggle ${isTank ? "active" : ""}" aria-pressed="${isTank}" aria-label="${isTank ? "수족관 등록됨" : "수족관 등록 안 됨"}">` +
        `<span class="tank-toggle-dot"></span><span class="tank-toggle-text">Aqua</span></button>` +
        `${isBoss ? '<span class="boss-badge">Boss</span>' : ""}` +
        `</div></div>`;

      const toggleCard = () => setItem(fish, { checked: !item.checked });
      card.addEventListener("click", toggleCard);
      card.addEventListener("keydown", (event) => {
        if (event.target.closest(".rank-control") || event.target.closest(".tank-toggle")) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toggleCard();
      });

      const rankControl = card.querySelector(".rank-control");
      rankControl.addEventListener("click", (event) => event.stopPropagation());
      rankControl.querySelector(".rank-trigger").addEventListener("click", () => {
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
      tankToggle.addEventListener("click", (event) => {
        event.stopPropagation();
        setItem(fish, { tank: !isTank });
      });

      grid.appendChild(card);
    });

    app.appendChild(section);
  });
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
  $("syncConnectBtn").disabled = sync.connecting || sync.connected;
  $("syncDisconnectBtn").hidden = !sync.connected && !sync.connecting;
  $("syncDisconnectBtn").disabled = sync.connecting;
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
    updateSyncStatus("Sync Key를 입력해 주세요.", "warn");
    return;
  }

  if (!isFirebaseConfigured()) {
    updateSyncStatus("firebase-config.js 설정이 필요합니다.", "warn");
    return;
  }

  const db = getFirebaseDb();
  if (!db) {
    updateSyncStatus("Firebase 초기화에 실패했습니다.", "error");
    return;
  }

  disconnectSync({ silent: true });
  sync.connecting = true;
  renderSyncControls();
  updateSyncStatus("동기화 연결 중...", "idle");

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
      // 원격 문서 존재: 같은 키로 재연결이고 로컬이 더 최신일 때만 로컬을 푸시하고,
      // 그 외(다른 키로 전환 등)에는 이 키의 원격 데이터를 그대로 채택해 교차 오염을 막는다.
      if (sameKeyAsLocal && stateModifiedAt > remoteModifiedAt) {
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
        updateSyncStatus(`동기화 연결됨: ${sync.key}`, "ok");
      },
      () => {
        sync.connecting = false;
        sync.connected = false;
        renderSyncControls();
        updateSyncStatus("동기화 연결 오류", "error");
      },
    );

    sync.connected = true;
    sync.connecting = false;
    renderSyncControls();
    updateSyncStatus(`동기화 연결됨: ${sync.key}`, "ok");
  } catch {
    sync.connecting = false;
    sync.connected = false;
    sync.docRef = null;
    renderSyncControls();
    updateSyncStatus("동기화 연결 실패", "error");
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
    updateSyncStatus("로컬 저장만 사용 중", "idle");
  }
}

async function pushStateToRemote() {
  if (!sync.docRef) return;

  const payload = {
    state,
    modifiedAt: stateModifiedAt,
  };

  sync.lastRemoteHash = getStateHash(payload);

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
      updateSyncStatus("동기화 저장 실패", "error");
    });
  }, 180);
}

function initFilters() {
  renderAreaMenu();
  renderSyncControls();

  $("search").addEventListener("input", (event) => {
    filters.q = event.target.value.trim().toLowerCase();
    render();
  });

  $("areaFilterTrigger").addEventListener("click", (event) => {
    event.stopPropagation();
    setAreaMenuOpen(!areaMenuOpen);
  });

  $("areaFilterMenu").addEventListener("click", (event) => event.stopPropagation());

  $("todoOnly").addEventListener("click", () => {
    filters.todo = !filters.todo;
    $("todoOnly").classList.toggle("active", filters.todo);
    render();
  });

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

  $("syncConnectBtn").addEventListener("click", () => {
    connectSync();
  });

  $("syncDisconnectBtn").addEventListener("click", () => {
    disconnectSync();
  });

  $("syncKey").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      connectSync();
    }
  });
}

document.addEventListener("click", () => {
  if (openRankKey) {
    openRankKey = null;
    render();
    return;
  }
  if (areaMenuOpen) {
    setAreaMenuOpen(false);
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
  if (resetModalOpen) {
    setResetModalOpen(false);
  }
});

initFilters();
render();

if (sync.key) {
  updateSyncStatus("저장된 Sync Key로 연결 시도 중...", "idle");
  connectSync();
} else if (isFirebaseConfigured()) {
  updateSyncStatus("Sync Key를 입력하면 동기화할 수 있습니다.", "idle");
} else {
  updateSyncStatus("firebase-config.js 설정 후 동기화 가능", "warn");
}
