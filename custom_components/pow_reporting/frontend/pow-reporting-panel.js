const STORAGE_KEY = "pow-reporting-settings";

const POWER_UNITS = new Set(["W", "kW"]);
const ENERGY_UNITS = new Set(["Wh", "kWh"]);

function startOfLocalDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatNumber(value, maximumFractionDigits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "--";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(numeric);
}

function formatPowerWatts(entity) {
  const value = Number(entity?.state);
  const unit = entity?.attributes?.unit_of_measurement;
  if (!Number.isFinite(value)) return "--";
  const watts = unit === "kW" ? value * 1000 : value;
  return `${formatNumber(watts, 0)} W`;
}

function formatEnergyKwh(value, unit) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "--";
  const kwh = unit === "Wh" ? numeric / 1000 : numeric;
  return `${formatNumber(kwh, 2)} kWh`;
}

function formatCurrency(value, currency = "AUD") {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "--";
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(numeric);
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m ${String(secs).padStart(2, "0")}s`;
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

class PowReportingPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = undefined;
    this._entities = [];
    this._outlets = [];
    this._devices = new Map();
    this._entityRegistry = new Map();
    this._auditLog = [];
    this._activeReferences = {};
    this._busySwitches = new Set();
    this._allOffReference = "Master ALL Off";
    this._selectedEntity = "";
    this._period = "day";
    this._billingPeriod = "day";
    this._billingReport = { settings: { energy_rate: 0.32, currency: "AUD" }, active: [], completed: [], sessions: [] };
    this._billingMessage = "";
    this._portalQuery = "";
    this._panelMode = "admin";
    this._chartRows = [];
    this._loadingStats = false;
    this._renamePreview = [];
    this._renameBusy = false;
    this._renameMessage = "";
    this._pendingRender = false;
    this._renderTimer = undefined;
    this._settings = {
      name: "Adaptive Services ParkPower",
      logoUrl: "",
      accent: "#0f766e",
      filter: "sonoff,pow,esphome",
    };
    this._activeTab = "dashboard";
    this.shadowRoot.addEventListener("focusout", () => this._flushPendingRenderSoon());
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._bootstrapped) {
      this._bootstrapped = true;
      this._loadSettings();
      this._loadRegistries();
      this._loadOutletLog();
      this._loadBillingReport();
    }
    this._computeEntities();
    this._requestRender();
  }

  set panel(panel) {
    this._panel = panel;
    const config = panel?.config || {};
    this._settings = {
      ...this._settings,
      name: config.name || this._settings.name,
      logoUrl: config.logo_url || this._settings.logoUrl,
      filter: config.entity_filter || this._settings.filter,
    };
    this._panelMode = config.mode || "admin";
    if (this._panelMode === "portal") {
      this._activeTab = "portal";
    }
  }

  connectedCallback() {
    this._requestRender({ force: true });
  }

  _isUserEditing() {
    const active = this.shadowRoot?.activeElement;
    return Boolean(active && ["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName));
  }

  _flushPendingRenderSoon() {
    if (!this._pendingRender) return;
    window.setTimeout(() => {
      if (this._pendingRender && !this._isUserEditing()) {
        this._requestRender({ force: true });
      }
    }, 350);
  }

  _requestRender({ force = false } = {}) {
    if (!force && this._isUserEditing()) {
      this._pendingRender = true;
      return;
    }
    window.clearTimeout(this._renderTimer);
    this._renderTimer = window.setTimeout(() => {
      if (!force && this._isUserEditing()) {
        this._pendingRender = true;
        return;
      }
      this._pendingRender = false;
      this._render();
    }, force ? 0 : 80);
  }

  _loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      this._settings = { ...this._settings, ...saved };
    } catch (_err) {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  _saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this._settings));
  }

  async _loadRegistries() {
    if (!this._hass?.callWS) return;
    try {
      const [entities, devices] = await Promise.all([
        this._hass.callWS({ type: "config/entity_registry/list" }),
        this._hass.callWS({ type: "config/device_registry/list" }),
      ]);
      this._entityRegistry = new Map(entities.map((entity) => [entity.entity_id, entity]));
      this._devices = new Map(devices.map((device) => [device.id, device]));
      this._computeEntities();
      this._requestRender();
    } catch (err) {
      this._registryError = err?.message || "Unable to load registries";
    }
  }

  async _loadOutletLog() {
    if (!this._hass?.callWS) return;
    try {
      const data = await this._hass.callWS({ type: "pow_reporting/get_outlet_log" });
      this._auditLog = Array.isArray(data?.events) ? data.events : [];
      this._activeReferences = data?.active_references || {};
      this._requestRender();
    } catch (err) {
      this._auditError = err?.message || "Unable to load outlet audit log.";
    }
  }

  async _loadBillingReport() {
    if (!this._hass?.callWS) return;
    try {
      const data = await this._hass.callWS({ type: "pow_reporting/get_billing_report" });
      this._billingReport = {
        settings: { energy_rate: 0.32, currency: "AUD", ...(data?.settings || {}) },
        active: Array.isArray(data?.active) ? data.active : [],
        completed: Array.isArray(data?.completed) ? data.completed : [],
        sessions: Array.isArray(data?.sessions) ? data.sessions : [],
      };
      this._requestRender();
    } catch (err) {
      this._billingMessage = err?.message || "Unable to load billing report.";
    }
  }

  _computeEntities() {
    if (!this._hass?.states) return;
    const keywords = this._settings.filter
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);

    this._entities = Object.values(this._hass.states)
      .filter((entity) => entity.entity_id.startsWith("sensor."))
      .map((entity) => {
        const registry = this._entityRegistry.get(entity.entity_id) || {};
        const device = registry.device_id ? this._devices.get(registry.device_id) : undefined;
        const unit = entity.attributes.unit_of_measurement;
        const deviceClass = entity.attributes.device_class;
        const haystack = [
          entity.entity_id,
          entity.attributes.friendly_name,
          registry.original_name,
          device?.name_by_user,
          device?.name,
          device?.model,
          device?.manufacturer,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        const isPower = deviceClass === "power" || POWER_UNITS.has(unit);
        const isEnergy = deviceClass === "energy" || ENERGY_UNITS.has(unit);
        const keywordMatch = keywords.length === 0 || keywords.some((keyword) => haystack.includes(keyword));
        return {
          entity,
          registry,
          device,
          isPower,
          isEnergy,
          keywordMatch,
          name: entity.attributes.friendly_name || entity.entity_id,
        };
      })
      .filter((row) => (row.isPower || row.isEnergy) && row.keywordMatch)
      .sort((a, b) => a.name.localeCompare(b.name));

    const sensorRows = this._entities;
    this._outlets = Object.values(this._hass.states)
      .filter((entity) => entity.entity_id.startsWith("switch."))
      .map((entity) => {
        const registry = this._entityRegistry.get(entity.entity_id) || {};
        const device = registry.device_id ? this._devices.get(registry.device_id) : undefined;
        const haystack = [
          entity.entity_id,
          entity.attributes.friendly_name,
          registry.original_name,
          device?.name_by_user,
          device?.name,
          device?.model,
          device?.manufacturer,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        const keywordMatch = keywords.length === 0 || keywords.some((keyword) => haystack.includes(keyword));
        const isControl = !/(restart|update|firmware|reboot)/.test(haystack);
        const power = this._bestSensorForDevice(sensorRows, registry.device_id, "power");
        const energy = this._bestSensorForDevice(sensorRows, registry.device_id, "energy");
        return {
          entity,
          registry,
          device,
          keywordMatch,
          isControl,
          power,
          energy,
          name: entity.attributes.friendly_name || entity.entity_id,
        };
      })
      .filter((row) => row.keywordMatch && row.isControl)
      .sort((a, b) => a.name.localeCompare(b.name));

    if (!this._selectedEntity) {
      const firstEnergy = this._entities.find((row) => row.isEnergy);
      this._selectedEntity = firstEnergy?.entity.entity_id || this._entities[0]?.entity.entity_id || "";
    }
  }

  async _loadStats() {
    if (!this._hass?.callWS || !this._selectedEntity) return;
    this._loadingStats = true;
    this._statsError = "";
    this._chartRows = [];
    this._requestRender({ force: true });

    const now = new Date();
    const start = this._periodStart(now);
    try {
      const response = await this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: start.toISOString(),
        end_time: now.toISOString(),
        statistic_ids: [this._selectedEntity],
        period: this._period === "day" ? "5minute" : "hour",
        types: ["state", "sum", "mean", "min", "max"],
      });
      const rows = response?.[this._selectedEntity] || [];
      this._chartRows = rows.map((row) => ({
        time: new Date(row.start),
        value: row.sum ?? row.state ?? row.mean,
        min: row.min,
        max: row.max,
      })).filter((row) => Number.isFinite(Number(row.value)));
    } catch (err) {
      this._statsError = err?.message || "Recorder statistics are unavailable for this entity.";
    } finally {
      this._loadingStats = false;
      this._requestRender();
    }
  }

  _periodStart(now) {
    if (this._period === "week") {
      const start = startOfLocalDay(now);
      start.setDate(start.getDate() - 6);
      return start;
    }
    if (this._period === "month") {
      return new Date(now.getFullYear(), now.getMonth(), 1);
    }
    return startOfLocalDay(now);
  }

  _downloadCsv() {
    const entity = this._selectedEntity;
    const rows = [["entity_id", "time", "value", "min", "max"], ...this._chartRows.map((row) => [
      entity,
      row.time.toISOString(),
      row.value ?? "",
      row.min ?? "",
      row.max ?? "",
    ])];
    const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${entity || "pow-report"}-${this._period}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  _downloadAuditCsv() {
    const rows = [
      ["time", "outlet", "switch_entity_id", "action", "reference", "success", "error"],
      ...this._auditLog.map((event) => [
        event.time,
        event.outlet_name,
        event.switch_entity_id,
        event.action,
        event.reference,
        event.success,
        event.error || "",
      ]),
    ];
    const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "outlet-power-events.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  async _controlOutlet(switchEntityId, action, outletName) {
    if (!this._hass?.callWS) return;
    const referenceInput = this.shadowRoot.querySelector(`[data-reference-for="${switchEntityId}"]`);
    const existingReference = this._activeReferences[switchEntityId] || "";
    const reference = (referenceInput?.value || existingReference || "").trim();
    if (action === "turn_on" && !reference) {
      referenceInput?.focus();
      this._notice = "Enter a name, bay, or booking reference before turning an outlet on.";
      this._requestRender({ force: true });
      return;
    }

    this._busySwitches.add(switchEntityId);
    this._notice = "";
    this._requestRender({ force: true });
    try {
      await this._hass.callWS({
        type: "pow_reporting/control_outlet",
        switch_entity_id: switchEntityId,
        action,
        reference,
        outlet_name: outletName,
      });
      await this._loadOutletLog();
      await this._loadBillingReport();
    } catch (err) {
      this._notice = err?.message || "Unable to control outlet.";
    } finally {
      this._busySwitches.delete(switchEntityId);
      this._requestRender();
    }
  }

  async _allOff() {
    if (!this._hass?.callWS || !this._outlets.length) return;
    const reference = this.shadowRoot.querySelector("#all-off-reference")?.value.trim() || "Master ALL Off";
    const confirmed = confirm(`Turn off all ${this._outlets.length} outlets?`);
    if (!confirmed) return;

    this._allOffBusy = true;
    this._notice = "";
    this._requestRender({ force: true });
    try {
      await this._hass.callWS({
        type: "pow_reporting/all_off",
        switch_entity_ids: this._outlets.map((outlet) => outlet.entity.entity_id),
        reference,
      });
      await this._loadOutletLog();
      await this._loadBillingReport();
    } catch (err) {
      this._notice = err?.message || "Unable to run master all-off.";
    } finally {
      this._allOffBusy = false;
      this._requestRender();
    }
  }

  async _saveBillingSettings() {
    if (!this._hass?.callWS) return;
    const rate = Number(this.shadowRoot.querySelector("#billing-rate")?.value);
    const currency = this.shadowRoot.querySelector("#billing-currency")?.value.trim() || "AUD";
    this._billingMessage = "";
    this._requestRender({ force: true });
    try {
      const data = await this._hass.callWS({
        type: "pow_reporting/save_billing_settings",
        energy_rate: Number.isFinite(rate) ? rate : 0,
        currency,
      });
      this._billingReport = {
        settings: { energy_rate: 0.32, currency: "AUD", ...(data?.settings || {}) },
        active: Array.isArray(data?.active) ? data.active : [],
        completed: Array.isArray(data?.completed) ? data.completed : [],
        sessions: Array.isArray(data?.sessions) ? data.sessions : [],
      };
      this._billingMessage = "Billing settings saved.";
    } catch (err) {
      this._billingMessage = err?.message || "Unable to save billing settings.";
    } finally {
      this._requestRender();
    }
  }

  _billingPeriodStart(now = new Date()) {
    if (this._billingPeriod === "week") {
      const start = startOfLocalDay(now);
      start.setDate(start.getDate() - 6);
      return start;
    }
    if (this._billingPeriod === "month") {
      return new Date(now.getFullYear(), now.getMonth(), 1);
    }
    if (this._billingPeriod === "all") {
      return null;
    }
    return startOfLocalDay(now);
  }

  _filteredBillingSessions() {
    const start = this._billingPeriodStart();
    const sessions = this._billingReport.completed || [];
    if (!start) return sessions;
    return sessions.filter((session) => new Date(session.end_time || session.start_time) >= start);
  }

  _billingTotals(sessions = this._filteredBillingSessions()) {
    return sessions.reduce(
      (total, session) => {
        total.sessions += 1;
        total.duration += Number(session.duration_seconds) || 0;
        total.energy += Number(session.energy_kwh) || 0;
        total.cost += Number(session.cost) || 0;
        return total;
      },
      { sessions: 0, duration: 0, energy: 0, cost: 0 },
    );
  }

  _downloadBillingCsv() {
    const rows = [
      ["start", "end", "outlet", "switch_entity_id", "reference", "duration", "energy_kwh", "rate", "cost", "currency"],
      ...this._filteredBillingSessions().map((session) => [
        session.start_time,
        session.end_time,
        session.outlet_name,
        session.switch_entity_id,
        session.reference,
        session.duration_seconds,
        session.energy_kwh,
        session.rate,
        session.cost,
        session.currency,
      ]),
    ];
    const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `outlet-billing-${this._billingPeriod}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  _energyKwhForRow(row) {
    const value = Number(row?.entity?.state);
    if (!Number.isFinite(value)) return null;
    return row.entity.attributes.unit_of_measurement === "Wh" ? value / 1000 : value;
  }

  _aggregateMeterRows() {
    const rate = Number(this._billingReport.settings?.energy_rate ?? 0.32);
    const currency = this._billingReport.settings?.currency || "AUD";
    const rows = this._outlets
      .map((outlet) => {
        const energyKwh = this._energyKwhForRow(outlet.energy);
        if (!Number.isFinite(energyKwh)) return null;
        return {
          switchEntityId: outlet.entity.entity_id,
          outletName: outlet.name,
          energyEntityId: outlet.energy.entity.entity_id,
          meterName: outlet.energy.name,
          energyKwh,
          cost: energyKwh * rate,
          currency,
        };
      })
      .filter(Boolean);
    return {
      rows,
      energyKwh: rows.reduce((total, row) => total + row.energyKwh, 0),
      cost: rows.reduce((total, row) => total + row.cost, 0),
      currency,
    };
  }

  _downloadAggregateCostCsv() {
    const aggregate = this._aggregateMeterRows();
    const rate = this._billingReport.settings?.energy_rate ?? 0.32;
    const rows = [
      ["outlet", "switch_entity_id", "energy_entity_id", "meter_name", "meter_energy_kwh", "rate", "cost", "currency"],
      ...aggregate.rows.map((row) => [
        row.outletName,
        row.switchEntityId,
        row.energyEntityId,
        row.meterName,
        row.energyKwh,
        rate,
        row.cost,
        row.currency,
      ]),
      ["TOTAL", "", "", "", aggregate.energyKwh, rate, aggregate.cost, aggregate.currency],
    ];
    const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "aggregate-meter-cost.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  _bestSensorForDevice(sensorRows, deviceId, kind) {
    const candidates = sensorRows.filter((row) => row.registry.device_id === deviceId && (kind === "energy" ? row.isEnergy : row.isPower));
    if (!candidates.length) return undefined;
    if (kind === "power") return candidates[0];
    return [...candidates].sort((a, b) => this._energySensorScore(b) - this._energySensorScore(a))[0];
  }

  _energySensorScore(row) {
    const text = [
      row.entity.entity_id,
      row.entity.attributes.friendly_name,
      row.registry.original_name,
      row.registry.name,
    ].filter(Boolean).join(" ").toLowerCase();
    let score = 0;
    if (text.includes("total")) score += 30;
    if (text.includes("cumulative")) score += 25;
    if (text.includes("lifetime")) score += 25;
    if (text.includes("import")) score += 10;
    if (text.includes("daily")) score -= 25;
    if (text.includes("today")) score -= 20;
    return score;
  }

  async _loadRenamePreview({ apply = false } = {}) {
    if (!this._hass?.callWS) return;
    if (apply) {
      const changed = this._renamePreview.filter((item) => item.changed).length;
      const confirmed = confirm(`Apply ${changed} Home Assistant entity name changes?`);
      if (!confirmed) return;
    }

    this._renameBusy = true;
    this._renameMessage = "";
    this._requestRender({ force: true });
    try {
      const result = await this._hass.callWS({
        type: "pow_reporting/auto_name_entities",
        apply,
        entity_filter: this._settings.filter,
      });
      this._renamePreview = result.entities || [];
      this._renameMessage = apply
        ? "Entity display names updated in Home Assistant."
        : `${this._renamePreview.filter((item) => item.changed).length} proposed name changes found.`;
      await this._loadRegistries();
    } catch (err) {
      this._renameMessage = err?.message || "Unable to build entity name preview.";
    } finally {
      this._renameBusy = false;
      this._requestRender();
    }
  }

  _totals() {
    const powerWatts = this._entities
      .filter((row) => row.isPower)
      .reduce((total, row) => {
        const value = Number(row.entity.state);
        if (!Number.isFinite(value)) return total;
        return total + (row.entity.attributes.unit_of_measurement === "kW" ? value * 1000 : value);
      }, 0);
    const energyRows = this._entities.filter((row) => row.isEnergy);
    return {
      powerWatts,
      powerCount: this._entities.filter((row) => row.isPower).length,
      energyCount: energyRows.length,
      deviceCount: new Set(this._entities.map((row) => row.registry.device_id || row.entity.entity_id)).size,
      outletCount: this._outlets.length,
      outletsOn: this._outlets.filter((row) => row.entity.state === "on").length,
    };
  }

  _chartSvg() {
    if (!this._chartRows.length) return `<div class="empty">No statistic rows returned for this period.</div>`;
    const values = this._chartRows.map((row) => Number(row.value));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(max - min, 0.0001);
    const points = values.map((value, index) => {
      const x = (index / Math.max(values.length - 1, 1)) * 100;
      const y = 100 - ((value - min) / span) * 100;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(" ");
    return `
      <svg class="chart" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Energy report chart">
        <polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="2.5" vector-effect="non-scaling-stroke"></polyline>
      </svg>
      <div class="chart-meta">
        <span>Min ${formatNumber(min, 2)}</span>
        <span>Max ${formatNumber(max, 2)}</span>
        <span>Latest ${formatNumber(values.at(-1), 2)}</span>
      </div>`;
  }

  _render() {
    if (!this.shadowRoot) return;
    const totals = this._totals();
    const energyRows = this._entities.filter((row) => row.isEnergy);
    const powerRows = this._entities.filter((row) => row.isPower);
    const isPortal = this._panelMode === "portal";

    this.shadowRoot.innerHTML = `
      <style>${this._styles()}</style>
      <main class="${isPortal ? "portal-shell" : ""}" style="--accent: ${this._settings.accent}">
        <header>
          <div class="brand">
            ${this._settings.logoUrl ? `<img src="${htmlEscape(this._settings.logoUrl)}" alt="">` : `<div class="mark">P</div>`}
            <div>
              <h1>${htmlEscape(this._settings.name)}</h1>
              <p>${totals.outletsOn} of ${totals.outletCount} outlets on · ${this._entities.length} reporting entities</p>
            </div>
          </div>
          ${isPortal ? "" : `<nav>
            ${this._tabButton("dashboard", "Dashboard")}
            ${this._tabButton("outlets", "Outlets")}
            ${this._tabButton("reports", "Reports")}
            ${this._tabButton("settings", "Settings")}
          </nav>`}
        </header>
        ${this._notice ? `<p class="notice">${htmlEscape(this._notice)}</p>` : ""}
        ${isPortal ? this._portalView(totals) : ""}
        ${!isPortal && this._activeTab === "dashboard" ? this._dashboard(totals, powerRows, energyRows) : ""}
        ${!isPortal && this._activeTab === "outlets" ? this._outletsView() : ""}
        ${!isPortal && this._activeTab === "reports" ? this._reports() : ""}
        ${!isPortal && this._activeTab === "settings" ? this._settingsView() : ""}
      </main>
    `;

    this.shadowRoot.querySelectorAll("[data-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        this._activeTab = button.dataset.tab;
        if (this._activeTab === "reports" && !this._chartRows.length && !this._loadingStats) {
          this._loadStats();
          return;
        }
        this._render();
      });
    });
    this.shadowRoot.querySelector("#entity-select")?.addEventListener("change", (event) => {
      this._selectedEntity = event.target.value;
      this._loadStats();
    });
    this.shadowRoot.querySelector("#period-select")?.addEventListener("change", (event) => {
      this._period = event.target.value;
      this._loadStats();
    });
    this.shadowRoot.querySelector("#refresh-stats")?.addEventListener("click", () => this._loadStats());
    this.shadowRoot.querySelector("#download-csv")?.addEventListener("click", () => this._downloadCsv());
    this.shadowRoot.querySelector("#download-audit-csv")?.addEventListener("click", () => this._downloadAuditCsv());
    this.shadowRoot.querySelector("#download-billing-csv")?.addEventListener("click", () => this._downloadBillingCsv());
    this.shadowRoot.querySelector("#download-aggregate-cost-csv")?.addEventListener("click", () => this._downloadAggregateCostCsv());
    this.shadowRoot.querySelector("#billing-period-select")?.addEventListener("change", (event) => {
      this._billingPeriod = event.target.value;
      this._render();
    });
    this.shadowRoot.querySelector("#save-billing-settings")?.addEventListener("click", () => this._saveBillingSettings());
    this.shadowRoot.querySelector("#portal-search")?.addEventListener("input", (event) => {
      this._portalQuery = event.target.value;
      this._requestRender();
    });
    this.shadowRoot.querySelector("#master-all-off")?.addEventListener("click", () => this._allOff());
    this.shadowRoot.querySelectorAll("[data-outlet-action]").forEach((button) => {
      button.addEventListener("click", () => {
        this._controlOutlet(button.dataset.switchEntityId, button.dataset.outletAction, button.dataset.outletName);
      });
    });
    this.shadowRoot.querySelector("#save-settings")?.addEventListener("click", () => {
      this._settings = {
        name: this.shadowRoot.querySelector("#setting-name").value.trim() || "Adaptive Services ParkPower",
        logoUrl: this.shadowRoot.querySelector("#setting-logo").value.trim(),
        accent: this.shadowRoot.querySelector("#setting-accent").value || "#0f766e",
        filter: this.shadowRoot.querySelector("#setting-filter").value.trim(),
      };
      this._saveSettings();
      this._computeEntities();
      this._render();
    });
    this.shadowRoot.querySelector("#preview-entity-names")?.addEventListener("click", () => this._loadRenamePreview());
    this.shadowRoot.querySelector("#apply-entity-names")?.addEventListener("click", () => this._loadRenamePreview({ apply: true }));
  }

  _tabButton(tab, label) {
    return `<button class="${this._activeTab === tab ? "active" : ""}" data-tab="${tab}">${label}</button>`;
  }

  _dashboard(totals, powerRows, energyRows) {
    const billingTotals = this._billingTotals(this._filteredBillingSessions());
    const aggregate = this._aggregateMeterRows();
    const currency = this._billingReport.settings?.currency || "AUD";
    return `
      <section class="summary-grid">
        <article><span>Live load</span><strong>${formatNumber(totals.powerWatts, 0)} W</strong></article>
        <article><span>Outlets on</span><strong>${totals.outletsOn} / ${totals.outletCount}</strong></article>
        <article><span>Meter energy</span><strong>${htmlEscape(formatEnergyKwh(aggregate.energyKwh, "kWh"))}</strong></article>
        <article><span>Meter cost</span><strong>${htmlEscape(formatCurrency(aggregate.cost, currency))}</strong></article>
        <article><span>Session energy</span><strong>${htmlEscape(formatEnergyKwh(billingTotals.energy, "kWh"))}</strong></article>
        <article><span>Session cost</span><strong>${htmlEscape(formatCurrency(billingTotals.cost, currency))}</strong></article>
      </section>
      ${this._registryError ? `<p class="notice">${this._registryError}</p>` : ""}
      <section class="columns">
        <div>
          <h2>Live Power</h2>
          <div class="table">${powerRows.map((row) => this._entityRow(row, formatPowerWatts(row.entity))).join("") || `<div class="empty">No matching power sensors found.</div>`}</div>
        </div>
        <div>
          <h2>Energy Entities</h2>
          <div class="table">${energyRows.map((row) => this._entityRow(row, formatEnergyKwh(row.entity.state, row.entity.attributes.unit_of_measurement))).join("") || `<div class="empty">No matching energy sensors found.</div>`}</div>
        </div>
      </section>
    `;
  }

  _portalView(totals) {
    const query = this._portalQuery.trim().toLowerCase();
    const activeSessions = this._billingReport.active || [];
    const filtered = this._outlets.filter((outlet) => {
      const session = activeSessions.find((item) => item.switch_entity_id === outlet.entity.entity_id);
      const text = [
        outlet.name,
        outlet.entity.entity_id,
        outlet.device?.name_by_user,
        outlet.device?.name,
        session?.reference,
      ].filter(Boolean).join(" ").toLowerCase();
      return !query || text.includes(query);
    });
    const aggregate = this._aggregateMeterRows();
    const currency = this._billingReport.settings?.currency || "AUD";
    return `
      <section class="portal-hero">
        <div>
          <span>EV outlet usage</span>
          <h2>${totals.outletsOn} active charging bays</h2>
          <p>${htmlEscape(formatPowerWatts({ state: totals.powerWatts, attributes: { unit_of_measurement: "W" } }))} live load · ${htmlEscape(formatCurrency(aggregate.cost, currency))} total metered cost</p>
        </div>
        <label>Find bay, outlet, or reference<input id="portal-search" value="${htmlEscape(this._portalQuery)}" placeholder="Bay 4, Smith, L2-B2"></label>
      </section>
      <section class="portal-grid">
        ${filtered.map((outlet) => this._portalCard(outlet)).join("") || `<div class="empty">No matching charging bays found.</div>`}
      </section>
    `;
  }

  _portalCard(outlet) {
    const switchEntityId = outlet.entity.entity_id;
    const isOn = outlet.entity.state === "on";
    const session = (this._billingReport.active || []).find((item) => item.switch_entity_id === switchEntityId);
    const power = outlet.power ? formatPowerWatts(outlet.power.entity) : "--";
    const energy = outlet.energy ? formatEnergyKwh(outlet.energy.entity.state, outlet.energy.entity.attributes.unit_of_measurement) : "--";
    return `
      <article class="portal-card ${isOn ? "is-on" : ""}">
        <div class="charge-visual">
          <span class="vehicle">EV</span>
          <i></i>
          <span class="charger">${isOn ? "ON" : "OFF"}</span>
        </div>
        <div class="outlet-top">
          <div>
            <h2>${htmlEscape(outlet.name)}</h2>
            <p>${htmlEscape(session?.reference || outlet.device?.name_by_user || switchEntityId)}</p>
          </div>
          <span class="status">${isOn ? "Charging" : "Inactive"}</span>
        </div>
        <div class="meter-row">
          <span><b>${htmlEscape(power)}</b><small>Live load</small></span>
          <span><b>${htmlEscape(energy)}</b><small>Meter</small></span>
          <span><b>${session ? htmlEscape(formatDuration(session.duration_seconds)) : "--"}</b><small>Charging for</small></span>
          <span><b>${session ? htmlEscape(formatCurrency(session.cost, session.currency)) : "--"}</b><small>Session cost</small></span>
        </div>
      </article>
    `;
  }

  _entityRow(row, value) {
    const deviceName = row.device?.name_by_user || row.device?.name || row.registry.platform || "Unassigned";
    return `
      <button class="entity-row" data-entity="${row.entity.entity_id}">
        <span>
          <strong>${htmlEscape(row.name)}</strong>
          <small>${htmlEscape(deviceName)} · ${htmlEscape(row.entity.entity_id)}</small>
        </span>
        <b>${htmlEscape(value)}</b>
      </button>`;
  }

  _outletsView() {
    return `
      <section class="master-control">
        <div>
          <h2>Master Control</h2>
          <p>Immediate shutdown for all managed car park outlets.</p>
        </div>
        <input id="all-off-reference" value="${htmlEscape(this._allOffReference)}" placeholder="Reason or reference">
        <button id="master-all-off" class="danger" ${this._allOffBusy || !this._outlets.length ? "disabled" : ""}>ALL Off</button>
      </section>
      <section class="outlet-grid">
        ${this._outlets.map((outlet) => this._outletCard(outlet)).join("") || `<div class="empty">No matching outlet switches found.</div>`}
      </section>
      <section class="audit-card">
        <div class="section-head">
          <h2>Power Event Log</h2>
          <button id="download-audit-csv" ${this._auditLog.length ? "" : "disabled"}>CSV</button>
        </div>
        ${this._auditError ? `<p class="notice">${htmlEscape(this._auditError)}</p>` : ""}
        <div class="audit-table">${this._auditRows()}</div>
      </section>
    `;
  }

  _outletCard(outlet) {
    const switchEntityId = outlet.entity.entity_id;
    const isOn = outlet.entity.state === "on";
    const busy = this._busySwitches.has(switchEntityId);
    const activeReference = this._activeReferences[switchEntityId] || "";
    const power = outlet.power ? formatPowerWatts(outlet.power.entity) : "--";
    const energy = outlet.energy ? formatEnergyKwh(outlet.energy.entity.state, outlet.energy.entity.attributes.unit_of_measurement) : "--";
    const activeSession = (this._billingReport.active || []).find((session) => session.switch_entity_id === switchEntityId);
    const status = isOn ? "On" : "Off";
    return `
      <article class="outlet-card ${isOn ? "is-on" : ""}">
        <div class="outlet-top">
          <div>
            <h2>${htmlEscape(outlet.name)}</h2>
            <p>${htmlEscape(switchEntityId)}</p>
          </div>
          <span class="status">${status}</span>
        </div>
        <div class="meter-row">
          <span><b>${htmlEscape(power)}</b><small>Live load</small></span>
          <span><b>${htmlEscape(energy)}</b><small>Energy</small></span>
          <span><b>${activeSession ? htmlEscape(formatDuration(activeSession.duration_seconds)) : "--"}</b><small>Charging for</small></span>
          <span><b>${activeSession ? htmlEscape(formatCurrency(activeSession.cost, activeSession.currency)) : "--"}</b><small>Session cost</small></span>
        </div>
        <label>Customer, bay, or booking reference
          <input data-reference-for="${htmlEscape(switchEntityId)}" value="${htmlEscape(activeReference)}" placeholder="Bay 14 - Smith">
        </label>
        <div class="outlet-actions">
          <button
            data-outlet-action="turn_on"
            data-switch-entity-id="${htmlEscape(switchEntityId)}"
            data-outlet-name="${htmlEscape(outlet.name)}"
            ${busy || isOn ? "disabled" : ""}
          >Power On</button>
          <button
            class="danger secondary"
            data-outlet-action="turn_off"
            data-switch-entity-id="${htmlEscape(switchEntityId)}"
            data-outlet-name="${htmlEscape(outlet.name)}"
            ${busy || !isOn ? "disabled" : ""}
          >Power Off</button>
        </div>
      </article>
    `;
  }

  _auditRows() {
    const rows = [...this._auditLog].reverse().slice(0, 80);
    if (!rows.length) return `<div class="empty">No outlet power events have been recorded yet.</div>`;
    return rows.map((event) => `
      <div class="audit-row">
        <span>${htmlEscape(new Date(event.time).toLocaleString())}</span>
        <strong>${htmlEscape(event.outlet_name)}</strong>
        <b class="${event.action === "turn_on" ? "event-on" : "event-off"}">${event.action === "turn_on" ? "On" : "Off"}</b>
        <span>${htmlEscape(event.reference || "")}</span>
        <small>${event.success ? "Success" : htmlEscape(event.error || "Failed")}</small>
      </div>
    `).join("");
  }

  _reports() {
    const options = this._entities
      .filter((row) => row.isEnergy || row.isPower)
      .map((row) => `<option value="${htmlEscape(row.entity.entity_id)}" ${row.entity.entity_id === this._selectedEntity ? "selected" : ""}>${htmlEscape(row.name)}</option>`)
      .join("");
    const billingSessions = this._filteredBillingSessions();
    const billingTotals = this._billingTotals(billingSessions);
    const aggregate = this._aggregateMeterRows();
    const currency = this._billingReport.settings?.currency || "AUD";
    return `
      <section class="report-controls">
        <label>Entity<select id="entity-select">${options}</select></label>
        <label>Period<select id="period-select">
          <option value="day" ${this._period === "day" ? "selected" : ""}>Today</option>
          <option value="week" ${this._period === "week" ? "selected" : ""}>Last 7 days</option>
          <option value="month" ${this._period === "month" ? "selected" : ""}>This month</option>
        </select></label>
        <button id="refresh-stats">Refresh</button>
        <button id="download-csv" ${this._chartRows.length ? "" : "disabled"}>CSV</button>
        <button id="download-audit-csv" ${this._auditLog.length ? "" : "disabled"}>Outlet Events CSV</button>
      </section>
      <section class="report-card">
        ${this._loadingStats ? `<div class="empty">Loading statistics...</div>` : ""}
        ${this._statsError ? `<p class="notice">${this._statsError}</p>` : ""}
        ${!this._loadingStats && !this._statsError ? this._chartSvg() : ""}
      </section>
      <section class="billing-card">
        <div class="section-head">
          <div>
            <h2>Aggregate Meter Cost</h2>
            <p>Total cost from current outlet energy meter readings. This ignores charging session start/stop events.</p>
          </div>
          <button id="download-aggregate-cost-csv" ${aggregate.rows.length ? "" : "disabled"}>Meter Cost CSV</button>
        </div>
        <section class="billing-summary">
          <article><span>Metered outlets</span><strong>${aggregate.rows.length}</strong></article>
          <article><span>Total meter energy</span><strong>${htmlEscape(formatEnergyKwh(aggregate.energyKwh, "kWh"))}</strong></article>
          <article><span>Rate</span><strong>${htmlEscape(formatCurrency(this._billingReport.settings?.energy_rate ?? 0.32, currency))}/kWh</strong></article>
          <article><span>Total meter cost</span><strong>${htmlEscape(formatCurrency(aggregate.cost, currency))}</strong></article>
        </section>
        <div class="billing-table aggregate-table">
          ${aggregate.rows.length ? [...aggregate.rows].sort((a, b) => b.cost - a.cost).map((row) => `
            <div class="aggregate-row">
              <strong>${htmlEscape(row.outletName)}</strong>
              <span>${htmlEscape(row.energyEntityId)}</span>
              <b>${htmlEscape(formatEnergyKwh(row.energyKwh, "kWh"))}</b>
              <b>${htmlEscape(formatCurrency(row.cost, row.currency))}</b>
            </div>
          `).join("") : `<div class="empty">No energy meter entities were found for the managed outlets.</div>`}
        </div>
      </section>
      <section class="billing-card">
        <div class="section-head">
          <div>
            <h2>Billing Sessions</h2>
            <p>Stored inside Home Assistant by this HACS integration.</p>
          </div>
          <div class="billing-actions">
            <label>Billing period<select id="billing-period-select">
              <option value="day" ${this._billingPeriod === "day" ? "selected" : ""}>Today</option>
              <option value="week" ${this._billingPeriod === "week" ? "selected" : ""}>Last 7 days</option>
              <option value="month" ${this._billingPeriod === "month" ? "selected" : ""}>This month</option>
              <option value="all" ${this._billingPeriod === "all" ? "selected" : ""}>All sessions</option>
            </select></label>
            <button id="download-billing-csv" ${billingSessions.length ? "" : "disabled"}>Billing CSV</button>
          </div>
        </div>
        ${this._billingMessage ? `<p class="notice">${htmlEscape(this._billingMessage)}</p>` : ""}
        <section class="billing-summary">
          <article><span>Sessions</span><strong>${billingTotals.sessions}</strong></article>
          <article><span>Duration</span><strong>${htmlEscape(formatDuration(billingTotals.duration))}</strong></article>
          <article><span>Energy</span><strong>${htmlEscape(formatEnergyKwh(billingTotals.energy, "kWh"))}</strong></article>
          <article><span>Cost</span><strong>${htmlEscape(formatCurrency(billingTotals.cost, currency))}</strong></article>
        </section>
        <div class="billing-table">
          ${billingSessions.length ? [...billingSessions].reverse().slice(0, 120).map((session) => `
            <div class="billing-row">
              <span>${htmlEscape(new Date(session.start_time).toLocaleString())}</span>
              <strong>${htmlEscape(session.outlet_name || session.switch_entity_id)}</strong>
              <span>${htmlEscape(formatDuration(session.duration_seconds))}</span>
              <b>${session.energy_kwh == null ? "--" : htmlEscape(formatEnergyKwh(session.energy_kwh, "kWh"))}</b>
              <b>${htmlEscape(formatCurrency(session.cost, session.currency || currency))}</b>
              <small>${htmlEscape(session.reference || "")}</small>
            </div>
          `).join("") : `<div class="empty">No completed billing sessions for this period yet.</div>`}
        </div>
      </section>
    `;
  }

  _settingsView() {
    const changed = this._renamePreview.filter((item) => item.changed).length;
    return `
      <section class="settings">
        <label>Dashboard name<input id="setting-name" value="${htmlEscape(this._settings.name)}"></label>
        <label>Logo URL<input id="setting-logo" value="${htmlEscape(this._settings.logoUrl)}" placeholder="/local/company-logo.png"></label>
        <label>Accent color<input id="setting-accent" type="color" value="${htmlEscape(this._settings.accent)}"></label>
        <label>Entity filter keywords<input id="setting-filter" value="${htmlEscape(this._settings.filter)}" placeholder="sonoff,pow,esphome"></label>
        <button id="save-settings">Save</button>
      </section>
      <section class="settings">
        <h2>Billing Settings</h2>
        <label>Energy rate<input id="billing-rate" type="number" min="0" step="0.01" value="${htmlEscape(this._billingReport.settings?.energy_rate ?? 0.32)}"></label>
        <label>Currency<input id="billing-currency" value="${htmlEscape(this._billingReport.settings?.currency || "AUD")}"></label>
        <button id="save-billing-settings">Save Billing Settings</button>
      </section>
      <section class="rename-tool">
        <div class="section-head">
          <div>
            <h2>Home Assistant Entity Naming</h2>
            <p>Build names from Floor, Bay/Spot label, and entity type. Example: L1-B7 Control, L1-B7 Watts, L1-B7 Amps.</p>
          </div>
          <div class="rename-actions">
            <button id="preview-entity-names" ${this._renameBusy ? "disabled" : ""}>Preview Names</button>
            <button id="apply-entity-names" class="danger secondary" ${this._renameBusy || !changed ? "disabled" : ""}>Apply ${changed || ""}</button>
          </div>
        </div>
        ${this._renameMessage ? `<p class="notice">${htmlEscape(this._renameMessage)}</p>` : ""}
        <div class="rename-table">
          ${this._renamePreview.length ? this._renamePreview.map((item) => `
            <div class="rename-row ${item.changed ? "will-change" : ""}">
              <span>${htmlEscape(item.entity_id)}</span>
              <strong>${htmlEscape(item.current_name || "")}</strong>
              <b>${htmlEscape(item.proposed_name)}</b>
              <small>${htmlEscape([item.floor, item.area, ...(item.labels || [])].filter(Boolean).join(" · "))}</small>
            </div>
          `).join("") : `<div class="empty">Preview proposed entity names before applying changes.</div>`}
        </div>
      </section>
    `;
  }

  _styles() {
    return `
      :host { display: block; min-height: 100vh; background: #f6f7f9; color: #172026; font-family: var(--paper-font-body1_-_font-family, system-ui, sans-serif); }
      main { box-sizing: border-box; min-height: 100vh; padding: 24px; }
      header { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-bottom: 24px; }
      .brand { display: flex; align-items: center; gap: 14px; min-width: 0; }
      .brand img, .mark { width: 48px; height: 48px; border-radius: 8px; object-fit: contain; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
      .mark { display: grid; place-items: center; background: var(--accent); color: #fff; font-weight: 800; font-size: 24px; }
      h1, h2, p { margin: 0; }
      h1 { font-size: 24px; line-height: 1.2; }
      h2 { font-size: 16px; margin: 0 0 10px; }
      p, small, label span { color: #5d6972; }
      nav { display: flex; gap: 6px; background: #e8edf0; padding: 4px; border-radius: 8px; }
      button, select, input { font: inherit; }
      button { border: 0; border-radius: 7px; padding: 9px 12px; background: #fff; color: #172026; cursor: pointer; }
      button.active, button:hover { background: var(--accent); color: #fff; }
      button.danger { background: #b91c1c; color: #fff; font-weight: 700; }
      button.danger.secondary { background: #fee2e2; color: #991b1b; }
      button:disabled { opacity: .45; cursor: default; }
      button:disabled:hover { background: #fff; color: #172026; }
      .summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 22px; }
      article, .report-card, .settings, .table, .master-control, .audit-card, .rename-tool, .billing-card, .portal-hero, .portal-card { background: #fff; border: 1px solid #dde3e7; border-radius: 8px; }
      article { padding: 16px; }
      article span { display: block; color: #5d6972; font-size: 13px; margin-bottom: 8px; }
      article strong { display: block; font-size: 28px; line-height: 1; }
      .columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
      .table { overflow: hidden; }
      .entity-row { display: flex; justify-content: space-between; align-items: center; width: 100%; gap: 14px; padding: 13px 14px; border-bottom: 1px solid #edf0f2; border-radius: 0; text-align: left; background: #fff; }
      .entity-row:hover { background: #f0f8f7; color: #172026; }
      .entity-row span { min-width: 0; }
      .entity-row strong, .entity-row small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .entity-row b { white-space: nowrap; }
      .empty, .notice { padding: 18px; color: #5d6972; }
      .notice { background: #fff7ed; border: 1px solid #fed7aa; border-radius: 8px; margin-bottom: 14px; }
      .report-controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; margin-bottom: 12px; }
      label { display: grid; gap: 6px; color: #5d6972; font-size: 13px; }
      select, input { min-width: 220px; border: 1px solid #cfd8de; border-radius: 7px; padding: 9px 10px; background: #fff; color: #172026; }
      .report-card { padding: 16px; min-height: 360px; }
      .master-control { display: grid; grid-template-columns: minmax(0, 1fr) minmax(220px, 320px) auto; gap: 12px; align-items: end; padding: 16px; margin-bottom: 16px; }
      .master-control p { margin-top: 4px; }
      .outlet-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; margin-bottom: 18px; }
      .outlet-card { display: grid; gap: 14px; }
      .outlet-card.is-on { border-color: color-mix(in srgb, var(--accent), #dde3e7 35%); box-shadow: inset 4px 0 0 var(--accent); }
      .outlet-top { display: flex; justify-content: space-between; gap: 12px; align-items: start; }
      .outlet-top p { margin-top: 4px; font-size: 12px; overflow: hidden; text-overflow: ellipsis; }
      .status { border-radius: 999px; padding: 4px 9px; background: #edf0f2; color: #33404a; font-size: 12px; font-weight: 700; }
      .is-on .status { background: #dcfce7; color: #166534; }
      .meter-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
      .meter-row span { display: grid; gap: 4px; background: #f6f7f9; border-radius: 7px; padding: 10px; }
      .meter-row b { font-size: 18px; }
      .meter-row small { color: #5d6972; }
      .outlet-actions { display: flex; gap: 8px; }
      .outlet-actions button { flex: 1; }
      .portal-shell { background: radial-gradient(circle at 12% 8%, color-mix(in srgb, var(--accent), transparent 78%), transparent 32%), linear-gradient(135deg, #081312, #12201f 52%, #0d1418); color: #e8f7f5; }
      .portal-shell header { color: #e8f7f5; }
      .portal-shell .brand p, .portal-shell p, .portal-shell small, .portal-shell label { color: #b9c9c8; }
      .portal-hero { display: grid; grid-template-columns: minmax(0, 1fr) minmax(220px, 380px); gap: 18px; align-items: end; padding: 22px; margin-bottom: 18px; color: #e8f7f5; background: linear-gradient(90deg, rgba(255,255,255,.1), rgba(255,255,255,.04)), repeating-linear-gradient(110deg, rgba(255,255,255,.05) 0 1px, transparent 1px 42px); border-color: rgba(255,255,255,.14); }
      .portal-hero span { color: var(--accent); font-size: 13px; font-weight: 800; text-transform: uppercase; }
      .portal-hero h2 { margin: 4px 0 8px; font-size: 34px; line-height: 1.05; }
      .portal-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }
      .portal-card { display: grid; gap: 14px; padding: 16px; color: #e8f7f5; background: rgba(255,255,255,.08); border-color: rgba(255,255,255,.13); box-shadow: 0 18px 46px rgba(0,0,0,.18); }
      .portal-card.is-on { border-color: color-mix(in srgb, var(--accent), white 15%); box-shadow: inset 4px 0 0 var(--accent), 0 0 34px color-mix(in srgb, var(--accent), transparent 78%); }
      .portal-card .meter-row span { background: rgba(255,255,255,.08); }
      .charge-visual { display: grid; grid-template-columns: auto minmax(60px, 1fr) auto; gap: 10px; align-items: center; color: var(--accent); }
      .charge-visual span { display: grid; place-items: center; width: 48px; height: 36px; border-radius: 8px; background: color-mix(in srgb, var(--accent), transparent 82%); font-size: 12px; font-weight: 800; }
      .charge-visual i { height: 5px; border-radius: 999px; background: linear-gradient(90deg, transparent, var(--accent), #67e8f9, transparent); background-size: 140px 100%; animation: chargeFlow 1.3s linear infinite; opacity: .75; }
      .portal-card:not(.is-on) .charge-visual i { animation: none; background: rgba(255,255,255,.16); }
      @keyframes chargeFlow { from { background-position: -140px 0; } to { background-position: 140px 0; } }
      .audit-card { padding: 16px; }
      .section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
      .audit-table { overflow: hidden; border: 1px solid #edf0f2; border-radius: 8px; }
      .audit-row { display: grid; grid-template-columns: 170px minmax(160px, 1.2fr) 70px minmax(140px, 1fr) minmax(90px, .7fr); gap: 10px; align-items: center; padding: 10px 12px; border-bottom: 1px solid #edf0f2; }
      .audit-row span, .audit-row small { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #5d6972; }
      .audit-row strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .event-on { color: #166534; }
      .event-off { color: #991b1b; }
      .billing-card { padding: 16px; margin-top: 16px; }
      .billing-actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; }
      .billing-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 12px 0; }
      .billing-summary article { border-color: #edf0f2; box-shadow: none; }
      .billing-summary strong { font-size: 22px; }
      .billing-table { overflow: hidden; border: 1px solid #edf0f2; border-radius: 8px; }
      .billing-row { display: grid; grid-template-columns: 170px minmax(150px, 1.1fr) 90px 100px 100px minmax(120px, 1fr); gap: 10px; align-items: center; padding: 10px 12px; border-bottom: 1px solid #edf0f2; }
      .billing-row span, .billing-row strong, .billing-row b, .billing-row small { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .billing-row span, .billing-row small { color: #5d6972; }
      .aggregate-row { display: grid; grid-template-columns: minmax(150px, 1fr) minmax(190px, 1fr) 120px 120px; gap: 10px; align-items: center; padding: 10px 12px; border-bottom: 1px solid #edf0f2; }
      .aggregate-row span, .aggregate-row strong, .aggregate-row b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .aggregate-row span { color: #5d6972; }
      .chart { display: block; width: 100%; height: 300px; background: linear-gradient(#edf1f3 1px, transparent 1px), linear-gradient(90deg, #edf1f3 1px, transparent 1px); background-size: 100% 25%, 12.5% 100%; border-radius: 8px; }
      .chart-meta { display: flex; justify-content: space-between; gap: 10px; margin-top: 12px; color: #5d6972; }
      .settings { display: grid; gap: 14px; max-width: 560px; padding: 16px; margin-bottom: 16px; }
      .settings label { color: #172026; }
      .rename-tool { padding: 16px; }
      .rename-tool p { margin-top: 4px; }
      .rename-actions { display: flex; gap: 8px; align-items: center; }
      .rename-table { overflow: hidden; border: 1px solid #edf0f2; border-radius: 8px; }
      .rename-row { display: grid; grid-template-columns: minmax(190px, 1.1fr) minmax(160px, 1fr) minmax(160px, 1fr) minmax(140px, .9fr); gap: 10px; align-items: center; padding: 10px 12px; border-bottom: 1px solid #edf0f2; }
      .rename-row.will-change { background: #f0fdf4; }
      .rename-row span, .rename-row strong, .rename-row b, .rename-row small { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .rename-row span, .rename-row small { color: #5d6972; }
      .rename-row b { color: #166534; }
      @media (max-width: 760px) {
        main { padding: 14px; }
        header, .columns { grid-template-columns: 1fr; display: grid; }
        .portal-hero { grid-template-columns: 1fr; }
        nav { overflow-x: auto; }
        .summary-grid, .billing-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .master-control, .audit-row, .rename-row, .billing-row, .aggregate-row { grid-template-columns: 1fr; }
        .outlet-actions { display: grid; }
        select, input { min-width: 0; width: 100%; box-sizing: border-box; }
      }
    `;
  }
}

customElements.define("pow-reporting-panel", PowReportingPanel);
