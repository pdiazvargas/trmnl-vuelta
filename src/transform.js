async function run(input) {
  const year = 2026;
  const baseUrl = "https://racecenter.lavuelta.es";

  const PREVIEW_STAGE = null;

  // Separate regex for checking (no g flag) vs replacing (g flag)
  const HAS_UNSAFE_CHARS = /[<>&"'`]/;
  const UNSAFE_CHAR_REGEX = /[<>&"'`]/g;
  const HTML_ESCAPE_MAP = {
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
    "'": "&#39;",
    "`": "&#96;"
  };

  function sanitizeString(value, fallback = "") {
    if (value === null || value === undefined) return fallback;

    const str = String(value).slice(0, 300);

    // Early exit—no dangerous chars, no work needed
    if (!HAS_UNSAFE_CHARS.test(str)) return str;

    return str.replace(UNSAFE_CHAR_REGEX, (char) => HTML_ESCAPE_MAP[char]);
  }

  function sanitizeStage(stage) {
    if (!stage || typeof stage !== "object") return stage;

    return {
      ...stage,
      from: sanitizeString(stage.from),
      to: sanitizeString(stage.to),
      startTime: sanitizeString(stage.startTime),
      endTime: sanitizeString(stage.endTime),
      type: sanitizeString(stage.type),
      departureCity: stage.departureCity
        ? {
            ...stage.departureCity,
            label: sanitizeString(stage.departureCity.label),
            content: stage.departureCity.content
          }
        : stage.departureCity,
      arrivalCity: stage.arrivalCity
        ? {
            ...stage.arrivalCity,
            label: sanitizeString(stage.arrivalCity.label),
            content: stage.arrivalCity.content
          }
        : stage.arrivalCity
    };
  }

  async function fetchJson(path) {
    if (
      typeof path !== "string" ||
      !path.startsWith("/api/") ||
      path.includes("..") ||
      path.includes("//") ||
      !/^\/api\/[a-zA-Z0-9/_-]+$/.test(path)
    ) {
      throw new Error("Invalid API path");
    }

    const url = new URL(path, baseUrl);
    const res = await fetch(url.toString());

    if (res.status === 204) return null;
    if (!res.ok) {
      throw new Error("Race Center API request failed");
    }

    return await res.json();
  }

  function dateKey(dateString) {
    return String(dateString).slice(0, 10);
  }

  function todayMadridKey() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Madrid",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());

    return `${parts.find((p) => p.type === "year").value}-${parts.find((p) => p.type === "month").value}-${parts.find((p) => p.type === "day").value}`;
  }

  function formatStartDate(dateString) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Madrid",
      month: "long",
      day: "numeric"
    }).formatToParts(new Date(dateString));

    return `${parts.find((p) => p.type === "month").value} ${parts.find((p) => p.type === "day").value}`.toUpperCase();
  }

  const stagesRaw = await fetchJson(`/api/stage-${year}`);

  const stages = stagesRaw
    .filter((stage) => stage && stage.stage && stage.date)
    .sort((a, b) => Number(a.stage) - Number(b.stage))
    .map(sanitizeStage);

  const firstStage = stages[0];
  const lastStage = stages[stages.length - 1];
  const currentDateKey = todayMadridKey();

  let today;
  let mode;

  if (PREVIEW_STAGE !== null) {
    today =
      stages.find((stage) => Number(stage.stage) === Number(PREVIEW_STAGE)) ||
      firstStage;
    mode = "preview_stage";
  } else if (currentDateKey < dateKey(firstStage.date)) {
    today = firstStage;
    mode = "before_tour";
  } else if (currentDateKey > dateKey(lastStage.date)) {
    today = lastStage;
    mode = "after_tour";
  } else {
    today =
      stages.find((stage) => dateKey(stage.date) === currentDateKey) ||
      stages.find((stage) => dateKey(stage.date) > currentDateKey) ||
      lastStage;
    mode = "during_tour";
  }

  const todayIndex = stages.findIndex(
    (stage) => Number(stage.stage) === Number(today.stage)
  );

  const tomorrow = stages[todayIndex + 1] || today;

  let gc = [];

  try {
    const rankingRaw = await fetchJson(`/api/ranking-${year}`);
    const rankingList = Array.isArray(rankingRaw)
      ? rankingRaw
      : rankingRaw?.data || rankingRaw?.rankings || [];

    gc = rankingList.slice(0, 3).map((r) => ({
      name: sanitizeString(r.name || r.riderName || r.fullName),
      team: sanitizeString(r.team || r.teamCode || r.teamName),
      time: r.time || r.totalTime,
      gap: r.gap || r.diff || r.timeGap
    }));
  } catch (error) {
    gc = [];
  }

  let routePoints = [];

  try {
    const checkpointRaw = await fetchJson(
      `/api/checkpoint-${year}-${today.stage}`
    );

    if (Array.isArray(checkpointRaw)) {
      routePoints = checkpointRaw;
    } else if (checkpointRaw?.data) {
      routePoints = checkpointRaw.data;
    } else if (checkpointRaw?.checkpoints) {
      routePoints = checkpointRaw.checkpoints;
    }
  } catch (error) {
    routePoints = [];
  }

  return {
    today,
    tomorrow,
    gc,
    routePoints,

    vueltaLogo: "https://www.lavuelta.es/img/global/logo-reversed@2x.png",

    preRaceHeader: {
      title: "VUELTA STARTS",
      date: sanitizeString(formatStartDate(firstStage.date)),
      location: sanitizeString(
        firstStage.departureCity?.label || firstStage.from || "START"
      ),
      stageNumber: sanitizeString(firstStage.stage),
      stage: sanitizeString(`STAGE ${firstStage.stage} OF ${stages.length}`),
      year: String(year)
    },

    debug: {
      mode,
      previewStage: PREVIEW_STAGE,
      currentDateKey,
      selectedStage: today.stage,
      selectedDate: today.date,
      nextStage: tomorrow.stage,
      firstStage: firstStage.stage,
      lastStage: lastStage.stage,
      gcCount: gc.length,
      routePointCount: routePoints.length
    }
  };
}
