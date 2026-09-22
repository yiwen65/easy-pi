"use strict";

/**
 * easy-pi token usage panel.
 *
 * Reads the frozen snapshot contract from `GET /api/stats` and renders it with
 * plain DOM APIs. No frameworks, no external requests, no build step.
 */

const API_URL = "/api/stats";
const SERVER_ROW_CAP = 500;
const COST_FRACTION_DIGITS = 3;

const els = {
  daysSelect: document.getElementById("days-select"),
  includeAllToggle: document.getElementById("include-all-toggle"),
  refreshButton: document.getElementById("refresh-button"),
  controlsForm: document.getElementById("controls-form"),
  statusBar: document.getElementById("status-bar"),
  summaryCards: document.getElementById("summary-cards"),
  chartContainer: document.getElementById("chart-container"),
  chartLegend: document.getElementById("chart-legend"),
  modelTable: document.getElementById("model-table"),
  providerTable: document.getElementById("provider-table"),
  projectTable: document.getElementById("project-table"),
  sessionsTable: document.getElementById("sessions-table"),
  excludedPanel: document.getElementById("excluded-panel"),
  excludedSummary: document.getElementById("excluded-summary"),
  rootList: document.getElementById("root-list"),
};

const state = {
  days: 30,
  includeAll: false,
  loading: false,
  error: null,
  data: null,
  requestedRange: null,
  sort: {
    model: { key: "cost", dir: -1 },
    provider: { key: "cost", dir: -1 },
    project: { key: "cost", dir: -1 },
    sessions: { key: "cost", dir: -1 },
  },
  visibleRows: { model: 15, provider: 15, project: 15, sessions: 25 },
};

const CHART_SERIES = [
  { key: "input", label: "Uncached input", color: "var(--c-input)" },
  { key: "cacheRead", label: "Cache read", color: "var(--c-cache-read)" },
  { key: "cacheWrite", label: "Cache write", color: "var(--c-cache-write)" },
  { key: "output", label: "Output", color: "var(--c-output)" },
];

// ---------------------------------------------------------------------------
// formatting helpers
// ---------------------------------------------------------------------------

function num(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fmtInt(value) {
  return Math.round(num(value)).toLocaleString("en-US");
}

function fmtCompact(value) {
  const n = num(value);
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return fmtInt(n);
}

function fmtCost(value) {
  return `$${num(value).toFixed(COST_FRACTION_DIGITS)}`;
}

function fmtPct(ratio) {
  return `${(num(ratio) * 100).toFixed(1)}%`;
}

function fmtDay(day) {
  const text = typeof day === "string" ? day : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text.slice(5) : "?";
}

function fmtDateTime(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString("en-US", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function truncateMiddle(text, max) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

function localDayString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function rangeForDays(days) {
  if (!days) return { from: null, to: null };
  const to = new Date();
  const from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - (days - 1));
  return { from: localDayString(from), to: localDayString(to) };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function elNs(tag, attrs) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs ?? {})) node.setAttribute(key, String(value));
  return node;
}

// ---------------------------------------------------------------------------
// data loading
// ---------------------------------------------------------------------------

function buildRequestUrl(refresh) {
  const params = new URLSearchParams();
  const range = rangeForDays(state.days);
  if (range.from) params.set("from", range.from);
  if (range.to) params.set("to", range.to);
  params.set("includeAll", state.includeAll ? "1" : "0");
  params.set("top", String(SERVER_ROW_CAP));
  if (refresh) params.set("refresh", "1");
  state.requestedRange = range;
  return `${API_URL}?${params.toString()}`;
}

async function load(refresh) {
  state.loading = true;
  state.error = null;
  renderStatus();
  els.refreshButton.disabled = true;
  try {
    const response = await fetch(buildRequestUrl(refresh), { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const payload = await response.json();
    if (!payload || typeof payload !== "object") throw new Error("Malformed snapshot payload");
    state.data = payload;
    state.error = null;
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.loading = false;
    els.refreshButton.disabled = false;
    render();
  }
}

// ---------------------------------------------------------------------------
// status + cards
// ---------------------------------------------------------------------------

function renderStatus() {
  const bar = els.statusBar;
  bar.classList.toggle("is-error", Boolean(state.error));
  bar.textContent = "";
  if (state.error) {
    bar.append(el("strong", null, "Could not load stats: "), document.createTextNode(state.error));
    return;
  }
  if (state.loading) {
    bar.textContent = "Loading…";
    return;
  }
  const data = state.data;
  if (!data) {
    bar.textContent = "No data loaded yet.";
    return;
  }
  const scan = data.scan ?? {};
  const parts = [];
  parts.push(`scanned ${fmtInt(scan.files)} files in ${fmtInt(scan.scanMs)} ms`);
  if (scan.cached) parts.push("served from server cache");
  if (num(scan.parseErrors) > 0) parts.push(`${fmtInt(scan.parseErrors)} parse errors`);
  const range = data.range ?? {};
  if (range.from || range.to) parts.push(`range ${range.from ?? "…"} → ${range.to ?? "…"}`);
  if (state.requestedRange?.from && range.from && range.from !== state.requestedRange.from) {
    parts.push(`requested from ${state.requestedRange.from}`);
  }
  parts.push(state.includeAll ? "including test/temp sessions" : "test/temp sessions excluded");
  bar.textContent = parts.join("  ·  ");

  if (els.rootList) {
    const roots = Array.isArray(scan.roots) ? scan.roots : [];
    els.rootList.textContent = roots.length > 0 ? `session roots: ${roots.join("  •  ")}` : "";
  }
}

function card(label, value, sub) {
  const node = el("div", "card");
  node.append(el("div", "card-label", label), el("div", "card-value", value));
  if (sub) node.append(el("div", "card-sub", sub));
  return node;
}

function renderCards() {
  const container = els.summaryCards;
  container.textContent = "";
  const data = state.data;
  if (!data) return;
  const totals = data.totals ?? {};
  const excluded = data.excluded ?? {};
  const promptTokens = num(totals.input) + num(totals.cacheRead) + num(totals.cacheWrite);

  container.append(
    card("Total tokens", fmtInt(totals.totalTokens), `${fmtInt(totals.messages)} billed messages`),
    card("Cost (catalog rates)", fmtCost(totals.cost), "as recorded when each message was written"),
    card("Cache hit rate", fmtPct(totals.cacheHitRate), "cache read / (input + cache read + cache write)"),
    card(
      "Prompt tokens",
      fmtInt(promptTokens),
      `uncached ${fmtCompact(totals.input)} · read ${fmtCompact(totals.cacheRead)} · write ${fmtCompact(totals.cacheWrite)}`,
    ),
    card("Output tokens", fmtInt(totals.output), "completion tokens"),
    card("Sessions", fmtInt(totals.sessions), `${fmtInt(excluded.sessions)} excluded`),
    card("Messages", fmtInt(totals.messages), "assistant, tool result, compaction, branch summary"),
  );
}

// ---------------------------------------------------------------------------
// chart
// ---------------------------------------------------------------------------

function chartTooltipTitle(row) {
  return [
    `${fmtDay(row.day)}`,
    `total ${fmtInt(row.totalTokens)} tokens`,
    `cost ${fmtCost(row.cost)}`,
    `in ${fmtCompact(row.input)}`,
    `read ${fmtCompact(row.cacheRead)}`,
    `write ${fmtCompact(row.cacheWrite)}`,
    `out ${fmtCompact(row.output)}`,
    `${fmtInt(row.sessions)} sessions`,
  ].join(" · ");
}

function buildChartSvg(rows, width) {
  const height = 230;
  const pad = { top: 14, right: 56, bottom: 26, left: 58 };
  const plotW = Math.max(80, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const svg = elNs("svg", {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: "img",
    "aria-label": "Daily token usage and cost",
  });

  const dayTotals = rows.map((row) =>
    CHART_SERIES.reduce((sum, series) => sum + num(row[series.key]), 0),
  );
  const maxTokens = Math.max(1, ...dayTotals);
  const maxCost = Math.max(0.000001, ...rows.map((row) => num(row.cost)));
  const step = plotW / Math.max(1, rows.length);
  const barW = Math.max(2, Math.min(28, step * 0.6));
  const yForCost = (value) => pad.top + plotH * (1 - value / maxCost);

  for (let tick = 0; tick <= 4; tick++) {
    const ratio = tick / 4;
    const y = pad.top + plotH * ratio;
    svg.append(elNs("line", { class: "grid-line", x1: pad.left, x2: pad.left + plotW, y1: y, y2: y }));
    const tokensLabel = elNs("text", { class: "axis-label", x: pad.left - 6, y: y + 3, "text-anchor": "end" });
    tokensLabel.textContent = fmtCompact(maxTokens * (1 - ratio));
    const costLabel = elNs("text", { class: "axis-label", x: pad.left + plotW + 6, y: y + 3 });
    costLabel.textContent = `$${(maxCost * (1 - ratio)).toFixed(2)}`;
    svg.append(tokensLabel, costLabel);
  }

  const labelEvery = Math.max(1, Math.ceil(rows.length / 8));
  const costPoints = [];

  rows.forEach((row, index) => {
    const x = pad.left + index * step + (step - barW) / 2;
    const group = elNs("g", {});
    const title = elNs("title", {});
    title.textContent = chartTooltipTitle(row);
    group.append(title);
    let cursor = pad.top + plotH;
    for (const series of CHART_SERIES) {
      const value = num(row[series.key]);
      const segH = (value / maxTokens) * plotH;
      if (segH <= 0) continue;
      cursor -= segH;
      group.append(
        elNs("rect", { class: "bar-seg", x, y: cursor, width: barW, height: segH, fill: series.color }),
      );
    }
    svg.append(group);
    costPoints.push({ x: x + barW / 2, y: yForCost(num(row.cost)) });

    if (index % labelEvery === 0 || index === rows.length - 1) {
      const label = elNs("text", {
        class: "axis-label",
        x: x + barW / 2,
        y: pad.top + plotH + 14,
        "text-anchor": "middle",
      });
      label.textContent = fmtDay(row.day);
      svg.append(label);
    }
  });

  if (costPoints.length > 0) {
    svg.append(
      elNs("polyline", {
        class: "cost-line",
        points: costPoints.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" "),
      }),
    );
    for (const point of costPoints) {
      svg.append(elNs("circle", { class: "cost-dot", cx: point.x, cy: point.y, r: 1.6 }));
    }
  }

  const axisTitle = elNs("text", { class: "axis-label", x: pad.left - 46, y: pad.top - 4 });
  axisTitle.textContent = "tokens";
  svg.append(axisTitle);
  const costTitle = elNs("text", { class: "axis-label", x: pad.left + plotW + 6, y: pad.top - 4 });
  costTitle.textContent = "cost";
  svg.append(costTitle);

  return svg;
}

function renderLegend() {
  const legend = els.chartLegend;
  legend.textContent = "";
  for (const series of CHART_SERIES) {
    const item = el("li");
    const swatch = el("span", "swatch");
    swatch.style.background = series.color;
    item.append(swatch, document.createTextNode(series.label));
    legend.append(item);
  }
  const costItem = el("li");
  const costSwatch = el("span", "swatch");
  costSwatch.style.background = "var(--c-cost)";
  costItem.append(costSwatch, document.createTextNode("Cost (right axis)"));
  legend.append(costItem);
}

function renderChart() {
  const container = els.chartContainer;
  container.textContent = "";
  const rows = Array.isArray(state.data?.byDay) ? state.data.byDay.slice() : [];
  rows.sort((a, b) => String(a.day).localeCompare(String(b.day)));
  if (rows.length === 0) {
    container.append(el("p", "empty", "No usage in the selected range."));
    return;
  }
  const width = Math.max(360, Math.floor(container.clientWidth || 900));
  container.append(buildChartSvg(rows, width));
}

// ---------------------------------------------------------------------------
// tables
// ---------------------------------------------------------------------------

function numericColumns(extra = []) {
  return [
    ...extra,
    { key: "input", label: "Input", numeric: true, value: (row) => num(row.input) },
    { key: "cacheRead", label: "Cache read", numeric: true, value: (row) => num(row.cacheRead) },
    { key: "cacheWrite", label: "Cache write", numeric: true, value: (row) => num(row.cacheWrite) },
    { key: "output", label: "Output", numeric: true, value: (row) => num(row.output) },
    { key: "totalTokens", label: "Total", numeric: true, value: (row) => num(row.totalTokens) },
    { key: "cost", label: "Cost", numeric: true, value: (row) => num(row.cost), format: fmtCost },
    { key: "sessions", label: "Sessions", numeric: true, value: (row) => num(row.sessions) },
    { key: "messages", label: "Messages", numeric: true, value: (row) => num(row.messages) },
  ];
}

const TABLES = {
  model: {
    rowsOf: (data) => data.byModel,
    columns: () => [
      { key: "key", label: "Model", value: (row) => String(row.key ?? "(unknown)"), format: (value) => truncateMiddle(value, 42) },
      ...numericColumns(),
    ],
  },
  provider: {
    rowsOf: (data) => data.byProvider,
    columns: () => [
      { key: "provider", label: "Provider", value: (row) => String(row.provider ?? "(unknown)"), format: (value) => truncateMiddle(value, 32) },
      ...numericColumns(),
    ],
  },
  project: {
    rowsOf: (data) => data.byProject,
    columns: () => [
      { key: "name", label: "Project", value: (row) => String(row.name ?? row.cwd ?? "(unknown)"), format: (value) => truncateMiddle(value, 40), title: (row) => String(row.cwd ?? "") },
      ...numericColumns(),
      { key: "lastUsedAt", label: "Last used", value: (row) => String(row.lastUsedAt ?? ""), format: fmtDateTime },
    ],
  },
  sessions: {
    rowsOf: (data) => data.sessions,
    columns: () => [
      { key: "startedAt", label: "Started", value: (row) => String(row.startedAt ?? ""), format: fmtDateTime },
      { key: "project", label: "Project", value: (row) => String(row.project ?? row.cwd ?? "(unknown)"), format: (value) => truncateMiddle(value, 28), title: (row) => String(row.cwd ?? "") },
      { key: "id", label: "Session", value: (row) => String(row.id ?? ""), format: (value) => truncateMiddle(value, 20), title: (row) => String(row.path ?? "") },
      { key: "models", label: "Models", value: (row) => (Array.isArray(row.models) ? row.models.join(", ") : ""), format: (value) => truncateMiddle(value, 34) },
      { key: "messages", label: "Messages", numeric: true, value: (row) => num(row.messages) },
      { key: "totalTokens", label: "Total", numeric: true, value: (row) => num(row.totalTokens) },
      { key: "cost", label: "Cost", numeric: true, value: (row) => num(row.cost), format: fmtCost },
    ],
  },
};

function sortRows(key, rows) {
  const sort = state.sort[key];
  const column = TABLES[key].columns().find((entry) => entry.key === sort.key);
  const value = column ? column.value : (row) => num(row.cost);
  return rows.slice().sort((a, b) => {
    const left = value(a);
    const right = value(b);
    if (typeof left === "number" && typeof right === "number") return (left - right) * sort.dir;
    return String(left).localeCompare(String(right)) * sort.dir;
  });
}

function renderTable(container, key) {
  container.textContent = "";
  const data = state.data;
  const spec = TABLES[key];
  if (!data) {
    container.append(el("p", "empty", "No data."));
    return;
  }
  const rows = spec.rowsOf(data) ?? [];
  if (!Array.isArray(rows) || rows.length === 0) {
    container.append(el("p", "empty", "No data."));
    return;
  }

  const columns = spec.columns();
  const sorted = sortRows(key, rows);
  const windowSize = state.visibleRows[key];
  const visible = sorted.slice(0, windowSize);

  const table = el("table");
  const caption = el(
    "caption",
    null,
    `Showing ${fmtInt(visible.length)} of ${fmtInt(sorted.length)} rows (server cap ${SERVER_ROW_CAP}). Sorting applies to loaded rows.`,
  );
  table.append(caption);

  const thead = el("thead");
  const headRow = el("tr");
  for (const column of columns) {
    const th = el("th", column.numeric ? "numeric sortable" : "sortable");
    th.append(el("span", null, column.label));
    const isActive = state.sort[key].key === column.key;
    th.setAttribute("aria-sort", isActive ? (state.sort[key].dir === -1 ? "descending" : "ascending") : "none");
    th.tabIndex = 0;
    const activate = () => {
      const current = state.sort[key];
      state.sort[key] =
        current.key === column.key
          ? { key: column.key, dir: -current.dir }
          : { key: column.key, dir: column.numeric ? -1 : 1 };
      renderTable(container, key);
    };
    th.addEventListener("click", activate);
    th.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    });
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);

  const tbody = el("tbody");
  for (const row of visible) {
    const tr = el("tr");
    for (const column of columns) {
      const raw = column.value(row);
      const text = column.format ? column.format(raw) : typeof raw === "number" ? fmtInt(raw) : String(raw ?? "");
      const td = el("td", column.numeric ? "numeric" : null, text);
      if (column.title) {
        const title = column.title(row);
        if (title) td.title = title;
      }
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  container.append(table);

  if (sorted.length > visible.length) {
    const foot = el("div", "table-foot");
    const more = el("button", "btn", `Show ${Math.min(50, sorted.length - visible.length)} more`);
    more.type = "button";
    more.addEventListener("click", () => {
      state.visibleRows[key] = windowSize + 50;
      renderTable(container, key);
    });
    foot.append(more, el("span", null, `${fmtInt(sorted.length - visible.length)} rows hidden`));
    container.append(foot);
  } else if (windowSize > (key === "sessions" ? 25 : 15)) {
    const foot = el("div", "table-foot");
    const collapse = el("button", "btn", "Collapse");
    collapse.type = "button";
    collapse.addEventListener("click", () => {
      state.visibleRows[key] = key === "sessions" ? 25 : 15;
      renderTable(container, key);
    });
    foot.append(collapse);
    container.append(foot);
  }
}

function renderExcluded() {
  const data = state.data;
  const excluded = data?.excluded ?? {};
  const reasons = excluded.reasons && typeof excluded.reasons === "object" ? Object.entries(excluded.reasons) : [];
  const hasData = num(excluded.sessions) > 0;
  els.excludedPanel.hidden = !hasData;
  els.excludedSummary.textContent = "";
  if (!hasData) return;
  const list = el("ul", "notes");
  list.append(el("li", null, `${fmtInt(excluded.sessions)} sessions · ${fmtInt(excluded.totalTokens)} tokens · ${fmtCost(excluded.cost)} (not counted above)`));
  for (const [reason, count] of reasons) {
    list.append(el("li", null, `${reason}: ${fmtInt(count)} sessions`));
  }
  els.excludedSummary.append(list);
}

function render() {
  renderStatus();
  renderCards();
  renderChart();
  renderLegend();
  renderExcluded();
  renderTable(els.modelTable, "model");
  renderTable(els.providerTable, "provider");
  renderTable(els.projectTable, "project");
  renderTable(els.sessionsTable, "sessions");
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

/** Apply `?days=<n>&includeAll=1` from the CLI-opened URL to the initial view. */
function applyUrlOverrides() {
  const params = new URLSearchParams(window.location.search);
  const days = params.get("days");
  if (days !== null && /^\d+$/.test(days)) {
    state.days = Number.parseInt(days, 10);
    let option = els.daysSelect.querySelector(`option[value="${state.days}"]`);
    if (option === null) {
      option = document.createElement("option");
      option.value = String(state.days);
      option.textContent = state.days === 0 ? "All time" : `Last ${state.days} days`;
      els.daysSelect.appendChild(option);
    }
    els.daysSelect.value = String(state.days);
  }
  if (params.get("includeAll") === "1") {
    state.includeAll = true;
    els.includeAllToggle.checked = true;
  }
}

function init() {
  if (els.controlsForm) els.controlsForm.addEventListener("submit", (event) => event.preventDefault());
  els.daysSelect.addEventListener("change", () => {
    state.days = Number.parseInt(els.daysSelect.value, 10) || 0;
    for (const key of Object.keys(state.visibleRows)) {
      state.visibleRows[key] = key === "sessions" ? 25 : 15;
    }
    void load(false);
  });
  els.includeAllToggle.addEventListener("change", () => {
    state.includeAll = els.includeAllToggle.checked;
    void load(false);
  });
  els.refreshButton.addEventListener("click", () => void load(true));

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (resizeTimer !== null) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => renderChart(), 150);
  });

  applyUrlOverrides();
  state.days = Number.parseInt(els.daysSelect.value, 10) || 0;
  void load(false);
}

init();
