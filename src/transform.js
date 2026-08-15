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

  async function fetchText(path) {
    const url = new URL(path, baseUrl);
    const res = await fetch(url.toString());

    if (!res.ok) {
      throw new Error("Race Center asset request failed");
    }

    return await res.text();
  }

  // The elevation profile isn't exposed through the documented /api/ JSON
  // endpoints—the race center's own frontend loads it as a webpack-bundled,
  // content-hashed CSV asset. Rediscovering the current hash means walking
  // the same lookup its SPA does: homepage -> shared bundle -> per-stage
  // chunk -> CSV. Each step is regex-matched defensively; any miss (ASO
  // reshapes their build output) throws and the caller falls back to no
  // profile rather than a broken render.
  async function fetchElevationProfile(stageNumber) {
    const CHART_WIDTH = 720;
    const CHART_HEIGHT = 92;
    const AXIS_HEIGHT = 16;
    const SAMPLE_POINTS = 100;

    const stagePadded = String(stageNumber).padStart(2, "0");
    const csvKey = `./${year}/profile-${stagePadded}-tiny.csv`;
    const escapedKey = csvKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const homeHtml = await fetchText("/");

    const commonMatch = homeHtml.match(/\/js\/chunk-common\.[a-f0-9]+\.js/);
    if (!commonMatch) throw new Error("Could not locate shared bundle");
    const commonJs = await fetchText(commonMatch[0]);

    const mapMatch = commonJs.match(
      new RegExp(`"${escapedKey}":\\["([a-f0-9]+)",(\\d+)\\]`)
    );
    if (!mapMatch) throw new Error("Could not locate profile chunk mapping");
    const chunkNumber = mapMatch[2];

    const chunkMatch = homeHtml.match(
      new RegExp(`/js/${chunkNumber}\\.[a-f0-9]+\\.js`)
    );
    if (!chunkMatch) throw new Error("Could not locate profile chunk file");
    const chunkJs = await fetchText(chunkMatch[0]);

    const csvPathMatch = chunkJs.match(/profils\/[^"]+\.csv/);
    if (!csvPathMatch) throw new Error("Could not locate profile CSV path");

    const csvText = await fetchText(`/${csvPathMatch[0]}`);
    return parseElevationCsv(csvText, { CHART_WIDTH, CHART_HEIGHT, AXIS_HEIGHT, SAMPLE_POINTS });
  }

  // Picks a km spacing for axis ticks so long stages don't end up with
  // dozens of crowded gridlines.
  function pickTickInterval(totalKm) {
    const candidates = [10, 20, 25, 50];
    for (const interval of candidates) {
      if (totalKm / interval <= 14) return interval;
    }
    return 50;
  }

  function parseElevationCsv(csvText, { CHART_WIDTH, CHART_HEIGHT, AXIS_HEIGHT, SAMPLE_POINTS }) {
    const lines = csvText.trim().split("\n");
    const header = lines[0].split(";");
    const kmIdx = header.indexOf("kmdone");
    const altIdx = header.indexOf("altitude");
    const typeIdx = header.indexOf("cptype");
    const catIdx = header.indexOf("sumcategory");

    const rows = lines
      .slice(1)
      .map((line) => {
        const cols = line.split(";");
        return {
          km: parseFloat(cols[kmIdx]),
          altitude: parseFloat(cols[altIdx]),
          cptype: (cols[typeIdx] || "").trim(),
          category: (cols[catIdx] || "").trim()
        };
      })
      .filter((r) => !isNaN(r.km) && !isNaN(r.altitude));

    if (rows.length < 2) return null;

    const totalKm = rows[rows.length - 1].km;
    const altitudes = rows.map((r) => r.altitude);
    const minAlt = Math.min.apply(null, altitudes);
    const maxAlt = Math.max.apply(null, altitudes);
    const altRange = maxAlt - minAlt || 1;

    // Reserve headroom above the curve's peak so marker circles/labels
    // (drawn above their point) never get pushed off the top of the chart.
    const MARKER_HEADROOM = 22;
    const BASELINE_MARGIN = 2;
    // Inset the plotted range so the first/last axis labels (and the
    // start/finish glyphs) sit inside the viewBox instead of straddling
    // x=0/x=width, where the card's rounded corners clip them off.
    const H_MARGIN = 14;
    const scaleX = (km) =>
      Math.round(H_MARGIN + (km / totalKm) * (CHART_WIDTH - 2 * H_MARGIN));
    const scaleY = (alt) =>
      Math.round(
        CHART_HEIGHT -
          BASELINE_MARGIN -
          ((alt - minAlt) / altRange) * (CHART_HEIGHT - BASELINE_MARGIN - MARKER_HEADROOM)
      );

    const step = Math.max(1, Math.floor(rows.length / SAMPLE_POINTS));
    const sampled = [];
    for (let i = 0; i < rows.length; i += step) {
      sampled.push(rows[i]);
    }
    const lastRow = rows[rows.length - 1];
    if (sampled[sampled.length - 1] !== lastRow) sampled.push(lastRow);

    const points = sampled.map((r) => `${scaleX(r.km)},${scaleY(r.altitude)}`).join(" ");

    const markerTypes = { real: "start", summit: "summit", sprint: "sprint", arrival: "finish" };
    const markers = rows
      .filter((r) => markerTypes[r.cptype])
      .map((r) => ({
        x: scaleX(r.km),
        y: scaleY(r.altitude),
        type: markerTypes[r.cptype],
        category: sanitizeString(r.category),
        altitude: Math.round(r.altitude),
        km: Math.round(r.km * 10) / 10
      }));

    // Km-axis ticks along the baseline, plus a final tick at the true
    // finish distance so the axis always ends on the real stage length
    // rather than stopping short at the last round number.
    const tickInterval = pickTickInterval(totalKm);
    const ticks = [];
    for (let km = 0; km <= totalKm; km += tickInterval) {
      ticks.push({ x: scaleX(km), label: String(Math.round(km)) });
    }
    const lastTickKm = ticks.length
      ? ((ticks[ticks.length - 1].x - H_MARGIN) / (CHART_WIDTH - 2 * H_MARGIN)) * totalKm
      : 0;
    if (totalKm - lastTickKm > tickInterval / 3) {
      ticks.push({
        x: scaleX(totalKm),
        label: (Math.round(totalKm * 10) / 10).toFixed(1)
      });
    }
    ticks.forEach((t, i) => {
      if (i === 0) t.anchor = "start";
      else if (i === ticks.length - 1) t.anchor = "end";
      else t.anchor = "middle";
    });

    return {
      width: CHART_WIDTH,
      height: CHART_HEIGHT,
      totalHeight: CHART_HEIGHT + AXIS_HEIGHT,
      points,
      markers,
      ticks,
      minAltitude: Math.round(minAlt),
      maxAltitude: Math.round(maxAlt),
      totalKm
    };
  }

  // Checkpoint place names come through as road-book notes ("PM 3ª Col de
  // Saint Andrieu  desnivel 227 mts. distancia 4,7 km porcentaje 4,8%"). Strip
  // the category prefix and trailing gradient stats to get a clean name.
  // Returns plain (unescaped) text—callers sanitize after truncating so an
  // HTML entity never gets sliced in half.
  function cleanWaypointName(str) {
    if (!str) return "";
    let s = String(str);
    s = s.replace(/^PM\s*\d+ª\s*/i, "");
    s = s.split(/\s+desnivel\b/i)[0];
    s = s.replace(/\bmeta$/i, "");
    s = s.replace(/\s+/g, " ").trim();
    return s;
  }

  function truncateLabel(str, max) {
    if (!str) return "";
    return str.length > max ? `${str.slice(0, max - 1)}…` : str;
  }

  // Truncates plain text, then escapes it—escaping first risks slicing an
  // HTML entity (e.g. "&#39;") in half.
  function truncateAndSanitize(str, max) {
    return sanitizeString(truncateLabel(str, max));
  }

  // The checkpoint API's actual shape is a single-element array wrapping an
  // index-keyed object alongside unrelated metadata fields
  // ([{ "0": {...}, "1": {...}, "_id": "...", "_updatedAt": 123 }]) rather
  // than a flat array of checkpoints—normalize whatever shape shows up
  // defensively, picking out only the numerically-keyed entries.
  function normalizeCheckpoints(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) {
      const first = raw[0];
      if (first && typeof first === "object" && !Array.isArray(first)) {
        const indexed = Object.entries(first)
          .filter(([key, value]) => /^\d+$/.test(key) && value && typeof value === "object")
          .map(([, value]) => value);
        return indexed.length > 0 ? indexed : raw;
      }
      return raw;
    }
    if (raw.data) return Array.isArray(raw.data) ? raw.data : Object.values(raw.data);
    if (raw.checkpoints) return Array.isArray(raw.checkpoints) ? raw.checkpoints : Object.values(raw.checkpoints);
    return [];
  }

  function classifyCheckpoint(cp) {
    const types = Array.isArray(cp.checkpointTypes) ? cp.checkpointTypes.map((t) => t.type) : [];
    if (types.includes("arrival")) return "finish";
    if (Array.isArray(cp.checkpointSummits) && cp.checkpointSummits.length) return "climb";
    if (types.includes("sprint")) return "sprint";
    if (types.includes("real") || types.includes("fictive")) return "start";
    return null;
  }

  function pickEvenly(list, count) {
    if (list.length <= count) return list;
    const result = [];
    for (let i = 0; i < count; i++) {
      const idx = Math.round((i * (list.length - 1)) / (count - 1));
      if (!result.includes(list[idx])) result.push(list[idx]);
    }
    return result;
  }

  // Most checkpoints are unlabeled road-book turns/tunnels with no
  // coordinates—only a handful (start, categorized climbs, intermediate
  // sprints, finish) carry lat/lng. That's too sparse to trace the actual
  // road, so this renders a schematic sequence of named waypoints along the
  // stage's km axis rather than a literal map.
  function buildRouteDiagram(checkpointRaw, stage) {
    const WIDTH = 720;
    const HEIGHT = 46;
    const H_MARGIN = 16;
    const LABEL_MAX = 13;
    const MAX_INTERMEDIATE = 3;

    const checkpoints = normalizeCheckpoints(checkpointRaw);
    const geo = checkpoints.filter(
      (cp) =>
        cp &&
        typeof cp.latitude === "number" &&
        typeof cp.longitude === "number" &&
        typeof cp.length === "number"
    );

    if (geo.length < 2) return null;

    const byKm = [...geo].sort((a, b) => a.length - b.length);

    const classified = byKm.map((cp) => {
      const type = classifyCheckpoint(cp);
      let name = null;
      let category = null;

      if (type === "climb") {
        const summit = cp.checkpointSummits[0]?.summit;
        name = cleanWaypointName(summit?.name || cp.place);
        category = sanitizeString(cp.checkpointSummits[0]?.code, "");
      } else if (type === "sprint") {
        name = cleanWaypointName(cp.place);
      }

      return { km: cp.length, type, name, category };
    });

    const startKm = byKm[0].length;
    const finishKm = byKm[byKm.length - 1].length;

    const intermediate = classified
      .filter(
        (w) =>
          (w.type === "climb" || w.type === "sprint") &&
          w.name &&
          w.km > startKm + 1 &&
          w.km < finishKm - 1
      )
      .filter((w, i, arr) => arr.findIndex((x) => Math.abs(x.km - w.km) < 1) === i);

    const climbs = intermediate.filter((w) => w.type === "climb");
    const sprints = intermediate.filter((w) => w.type === "sprint");
    let selected = pickEvenly(climbs, MAX_INTERMEDIATE);
    if (selected.length < MAX_INTERMEDIATE) {
      selected = selected.concat(pickEvenly(sprints, MAX_INTERMEDIATE - selected.length));
    }
    selected.sort((a, b) => a.km - b.km);

    const totalKm = finishKm || stage.length || 1;
    const scaleX = (km) => Math.round(H_MARGIN + (km / totalKm) * (WIDTH - 2 * H_MARGIN));

    const ordered = [{ km: startKm, type: "start" }, ...selected, { km: finishKm, type: "finish" }];

    let intermediateIndex = 0;
    const points = ordered.map((w) => {
      let anchor = "middle";
      let align;
      // Start/finish names come from `stage`, already sanitized upstream by
      // sanitizeStage()—only truncate. Climb/sprint names are raw checkpoint
      // text and need both truncating and escaping.
      let name;

      if (w.type === "start") {
        name = truncateLabel(stage.departureCity?.label || stage.from || "START", LABEL_MAX);
        anchor = "start";
        align = "bottom";
      } else if (w.type === "finish") {
        name = truncateLabel(stage.arrivalCity?.label || stage.to || "FINISH", LABEL_MAX);
        anchor = "end";
        align = "bottom";
      } else {
        name = truncateAndSanitize(w.name, LABEL_MAX);
        align = intermediateIndex % 2 === 0 ? "top" : "bottom";
        intermediateIndex++;
      }

      return {
        x: scaleX(w.km),
        type: w.type,
        category: w.category || null,
        name,
        anchor,
        align
      };
    });

    return { width: WIDTH, height: HEIGHT, baselineY: 26, points };
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

  // TRMNL's docs don't pin down exactly where custom field selections land on
  // the transform input, so check the shapes seen in practice rather than
  // assuming one.
  function customField(input, keyname, fallback) {
    const sources = [
      input?.custom_fields,
      input?.custom_fields_values,
      input?.trmnl?.plugin_settings?.custom_fields_values,
      input?.trmnl?.custom_fields_values
    ];

    for (const source of sources) {
      if (source && typeof source === "object" && source[keyname]) {
        return source[keyname];
      }
    }

    return fallback;
  }

  function resolveDistanceUnit(input) {
    const raw = String(customField(input, "distance_unit", "Kilometers"));
    return /mile|mi\b/i.test(raw) ? "mi" : "km";
  }

  function resolveDisplayTimeZone(input) {
    const raw = String(customField(input, "display_timezone", "CEST"));
    return /eastern/i.test(raw) ? "America/New_York" : "Europe/Madrid";
  }

  function formatDistance(stage, unit) {
    const raw = stage.lengthDisplay ?? stage.length ?? stage.distance;
    const km = typeof raw === "number" ? raw : parseFloat(raw);

    if (isNaN(km)) {
      return { distanceValue: sanitizeString(raw, ""), distanceUnitLabel: "KM" };
    }

    if (unit === "mi") {
      return {
        distanceValue: String(Math.round(km * 0.621371 * 10) / 10),
        distanceUnitLabel: "MI"
      };
    }

    return { distanceValue: String(Math.round(km * 10) / 10), distanceUnitLabel: "KM" };
  }

  function stageStartDateTime(stage) {
    if (!stage || !stage.date || !stage.startTime) return null;

    const offsetMatch = String(stage.date).match(/([+-]\d{2}:\d{2})$/);
    const offset = offsetMatch ? offsetMatch[1] : "+02:00";
    const iso = `${dateKey(stage.date)}T${stage.startTime}${offset}`;
    const parsed = new Date(iso);

    return isNaN(parsed.getTime()) ? null : parsed;
  }

  function formatStartTime(stage, timeZone) {
    const fallback = {
      startTimeDisplay: sanitizeString(stage.startTime, "").slice(0, 5),
      startTimeZoneLabel: "CEST"
    };

    if (timeZone === "Europe/Madrid") return fallback;

    const date = stageStartDateTime(stage);
    if (!date) return fallback;

    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZoneName: "short"
    }).formatToParts(date);

    const hour = parts.find((p) => p.type === "hour")?.value;
    const minute = parts.find((p) => p.type === "minute")?.value;
    const tzName = parts.find((p) => p.type === "timeZoneName")?.value;

    if (!hour || !minute) return fallback;

    // "short" resolves to EST or EDT automatically depending on whether the
    // stage date falls inside US daylight saving time.
    return { startTimeDisplay: `${hour}:${minute}`, startTimeZoneLabel: sanitizeString(tzName, "ET") };
  }

  function decorateStage(stage, unit, timeZone) {
    if (!stage) return stage;
    return { ...stage, ...formatDistance(stage, unit), ...formatStartTime(stage, timeZone) };
  }

  const distanceUnit = resolveDistanceUnit(input);
  const displayTimeZone = resolveDisplayTimeZone(input);

  const stagesRaw = await fetchJson(`/api/stage-${year}`);

  const stages = stagesRaw
    .filter((stage) => stage && stage.stage && stage.date)
    .sort((a, b) => Number(a.stage) - Number(b.stage))
    .map(sanitizeStage)
    .map((stage) => decorateStage(stage, distanceUnit, displayTimeZone));

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
  let routeDiagram = null;

  try {
    const checkpointRaw = await fetchJson(
      `/api/checkpoint-${year}-${today.stage}`
    );

    routePoints = normalizeCheckpoints(checkpointRaw);
    routeDiagram = buildRouteDiagram(checkpointRaw, today);
  } catch (error) {
    routePoints = [];
    routeDiagram = null;
  }

  let elevationProfile = null;

  try {
    elevationProfile = await fetchElevationProfile(today.stage);
  } catch (error) {
    elevationProfile = null;
  }

  return {
    today,
    tomorrow,
    gc,
    routePoints,
    routeDiagram,
    elevationProfile,

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
      distanceUnit,
      displayTimeZone,
      selectedStage: today.stage,
      selectedDate: today.date,
      nextStage: tomorrow.stage,
      firstStage: firstStage.stage,
      lastStage: lastStage.stage,
      gcCount: gc.length,
      routePointCount: routePoints.length,
      routeWaypointCount: routeDiagram ? routeDiagram.points.length : 0,
      hasElevationProfile: !!elevationProfile
    }
  };
}
