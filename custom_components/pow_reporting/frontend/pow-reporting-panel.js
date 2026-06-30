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
    this._records = { customers: [], vehicles: [], user_groups: [] };
    this._hierarchy = {
      organisations: [],
      sites: [],
      buildings: [],
      distribution_boards: [],
      circuit_groups: [],
      outlet_mappings: [],
      discovered_outlets: [],
    };
    this._recordQuery = "";
    this._hierarchyQuery = "";
    this._busySwitches = new Set();
    this._allOffReference = "Master ALL Off";
    this._selectedEntity = "";
    this._period = "day";
    this._billingPeriod = "day";
    this._billingReport = { settings: { energy_rate: 0.32, currency: "AUD" }, active: [], completed: [], sessions: [] };
    this._managementReport = { kpis: {}, charts: {}, statement: {}, sessions: [] };
    this._managementMessage = "";
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
      this._loadManagementReport();
      this._loadRecords();
      this._loadHierarchy();
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

  async _loadManagementReport() {
    if (!this._hass?.callWS) return;
    try {
      const data = await this._hass.callWS({
        type: "pow_reporting/get_management_report",
        period: this._billingPeriod,
        filters: this._reportFilterPayload(),
      });
      this._managementReport = data || { kpis: {}, charts: {}, statement: {}, sessions: [] };
      this._requestRender();
    } catch (err) {
      this._managementMessage = err?.message || "Unable to load management report.";
    }
  }

  _reportFilterPayload() {
    const reference = this.shadowRoot?.querySelector("#report-reference-filter")?.value?.trim() || "";
    const outlet = this.shadowRoot?.querySelector("#report-outlet-filter")?.value || "";
    const billingStatus = this.shadowRoot?.querySelector("#report-billing-filter")?.value || "";
    return {
      ...(reference ? { reference } : {}),
      ...(outlet ? { outlet } : {}),
      ...(billingStatus ? { billing_status: billingStatus } : {}),
    };
  }

  async _loadRecords() {
    if (!this._hass?.callWS) return;
    try {
      this._records = await this._hass.callWS({
        type: "pow_reporting/get_records",
        query: this._recordQuery,
      });
      this._requestRender();
    } catch (err) {
      this._recordsError = err?.message || "Unable to load customer records.";
    }
  }

  async _loadHierarchy() {
    if (!this._hass?.callWS) return;
    try {
      this._hierarchy = await this._hass.callWS({
        type: "pow_reporting/get_hierarchy",
        query: this._hierarchyQuery,
      });
      this._requestRender();
    } catch (err) {
      this._hierarchyError = err?.message || "Unable to load site hierarchy.";
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
      await this._loadManagementReport();
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
      await this._loadManagementReport();
    } catch (err) {
      this._notice = err?.message || "Unable to run master all-off.";
    } finally {
      this._allOffBusy = false;
      this._requestRender();
    }
  }

  _formFields(form) {
    return Object.fromEntries([...new FormData(form).entries()].map(([key, value]) => [key, String(value).trim()]));
  }

  async _saveRecord(recordType, form) {
    if (!this._hass?.callWS) return;
    const fields = this._formFields(form);
    if (recordType === "user_group") {
      fields.priority = Number(fields.priority || 0);
      fields.discount_percentage = Number(fields.discount_percentage || 0);
      fields.charging_allowed = form.querySelector("[name='charging_allowed']")?.checked ?? false;
      fields.free_charging = form.querySelector("[name='free_charging']")?.checked ?? false;
    }
    this._recordsNotice = "";
    try {
      await this._hass.callWS({
        type: "pow_reporting/save_record",
        record_type: recordType,
        fields,
      });
      form.reset();
      this._recordsNotice = "Record saved.";
      await this._loadRecords();
    } catch (err) {
      this._recordsNotice = err?.message || "Unable to save record.";
      this._requestRender({ force: true });
    }
  }

  async _saveHierarchyRecord(recordType, form) {
    if (!this._hass?.callWS) return;
    const fields = this._formFields(form);
    if (["distribution_board", "circuit_group"].includes(recordType)) {
      [
        "maximum_current",
        "maximum_power",
        "reserve_margin",
        "warning_threshold",
        "maximum_simultaneous_outlets",
        "allocation_interval",
        "minimum_relay_on_duration",
        "minimum_relay_off_duration",
        "maximum_relay_operations_per_hour",
      ].forEach((key) => {
        if (key in fields) fields[key] = fields[key] === "" ? null : Number(fields[key]);
      });
      fields.enabled = form.querySelector("[name='enabled']")?.checked ?? false;
      if ("priority" in fields) fields.priority = Number(fields.priority || 0);
    }
    if (recordType === "outlet") {
      const discovered = this._hierarchy.discovered_outlets?.find((item) => item.switch_entity_id === fields.switch_entity_id);
      if (discovered) {
        fields.power_entity_id ||= discovered.power_entity_id || "";
        fields.energy_entity_id ||= discovered.energy_entity_id || "";
        fields.ha_area_id ||= discovered.ha_area_id || "";
        fields.ha_floor_id ||= discovered.ha_floor_id || "";
        fields.ha_label_ids ||= (discovered.ha_label_ids || []).join(",");
      }
    }
    this._hierarchyNotice = "";
    try {
      await this._hass.callWS({
        type: "pow_reporting/save_hierarchy_record",
        record_type: recordType,
        fields,
      });
      form.reset();
      this._hierarchyNotice = "Hierarchy record saved.";
      await this._loadHierarchy();
    } catch (err) {
      this._hierarchyNotice = err?.message || "Unable to save hierarchy record.";
      this._requestRender({ force: true });
    }
  }

  async _archiveHierarchyRecord(recordType, recordId) {
    if (!this._hass?.callWS || !recordId) return;
    try {
      await this._hass.callWS({
        type: "pow_reporting/archive_hierarchy_record",
        record_type: recordType,
        record_id: recordId,
      });
      await this._loadHierarchy();
    } catch (err) {
      this._hierarchyNotice = err?.message || "Unable to archive hierarchy record.";
      this._requestRender({ force: true });
    }
  }

  async _archiveRecord(recordType, recordId) {
    if (!this._hass?.callWS || !recordId) return;
    try {
      await this._hass.callWS({
        type: "pow_reporting/archive_record",
        record_type: recordType,
        record_id: recordId,
      });
      await this._loadRecords();
    } catch (err) {
      this._recordsNotice = err?.message || "Unable to archive record.";
      this._requestRender({ force: true });
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
      await this._loadManagementReport();
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

  _downloadManagementCsv() {
    const sessions = this._managementReport?.sessions || [];
    const rows = [
      ["start", "end", "outlet", "switch_entity_id", "reference", "customer", "vehicle", "user_group", "duration_seconds", "energy_kwh", "cost", "billing_status", "currency"],
      ...sessions.map((session) => [
        session.start,
        session.end,
        session.outlet,
        session.switch_entity_id,
        session.reference,
        session.customer,
        session.vehicle,
        session.user_group,
        session.duration_seconds,
        session.energy_kwh,
        session.cost,
        session.billing_status,
        session.currency,
      ]),
    ];
    const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `management-report-${this._billingPeriod}.csv`;
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

  _liveSessionDuration(session) {
    if (!session?.start_time) return session?.duration_seconds;
    const start = new Date(session.start_time).getTime();
    if (!Number.isFinite(start)) return session.duration_seconds;
    return Math.max(0, Math.round((Date.now() - start) / 1000));
  }

  _liveSessionCost(session, outlet) {
    if (!session) return null;
    const startEnergy = Number(session.start_energy_kwh);
    const currentEnergy = this._energyKwhForRow(outlet.energy);
    if (Number.isFinite(startEnergy) && Number.isFinite(currentEnergy)) {
      const rate = Number(session.rate ?? this._billingReport.settings?.energy_rate ?? 0.32);
      return Math.max(0, currentEnergy - startEnergy) * rate;
    }
    return Number.isFinite(Number(session.cost)) ? Number(session.cost) : null;
  }

  _formatLiveSessionCost(session, outlet) {
    const cost = this._liveSessionCost(session, outlet);
    if (!Number.isFinite(cost)) return "--";
    return formatCurrency(cost, session?.currency || this._billingReport.settings?.currency || "AUD");
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
            ${this._tabButton("records", "Records")}
            ${this._tabButton("hierarchy", "Hierarchy")}
            ${this._tabButton("settings", "Settings")}
          </nav>`}
        </header>
        ${this._notice ? `<p class="notice">${htmlEscape(this._notice)}</p>` : ""}
        ${isPortal ? this._portalView(totals) : ""}
        ${!isPortal && this._activeTab === "dashboard" ? this._dashboard(totals, powerRows, energyRows) : ""}
        ${!isPortal && this._activeTab === "outlets" ? this._outletsView() : ""}
        ${!isPortal && this._activeTab === "reports" ? this._reports() : ""}
        ${!isPortal && this._activeTab === "records" ? this._recordsView() : ""}
        ${!isPortal && this._activeTab === "hierarchy" ? this._hierarchyView() : ""}
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
    this.shadowRoot.querySelector("#download-management-csv")?.addEventListener("click", () => this._downloadManagementCsv());
    this.shadowRoot.querySelector("#download-aggregate-cost-csv")?.addEventListener("click", () => this._downloadAggregateCostCsv());
    this.shadowRoot.querySelector("#billing-period-select")?.addEventListener("change", (event) => {
      this._billingPeriod = event.target.value;
      this._loadManagementReport();
      this._render();
    });
    this.shadowRoot.querySelector("#refresh-management-report")?.addEventListener("click", () => this._loadManagementReport());
    this.shadowRoot.querySelectorAll("[data-management-filter]").forEach((input) => {
      input.addEventListener("change", () => this._loadManagementReport());
    });
    this.shadowRoot.querySelector("#save-billing-settings")?.addEventListener("click", () => this._saveBillingSettings());
    this.shadowRoot.querySelector("#portal-search")?.addEventListener("input", (event) => {
      this._portalQuery = event.target.value;
      this._requestRender();
    });
    this.shadowRoot.querySelector("#record-search")?.addEventListener("input", (event) => {
      this._recordQuery = event.target.value;
      window.clearTimeout(this._recordSearchTimer);
      this._recordSearchTimer = window.setTimeout(() => this._loadRecords(), 250);
    });
    this.shadowRoot.querySelectorAll("[data-record-form]").forEach((form) => {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        this._saveRecord(form.dataset.recordForm, form);
      });
    });
    this.shadowRoot.querySelectorAll("[data-archive-record]").forEach((button) => {
      button.addEventListener("click", () => {
        this._archiveRecord(button.dataset.recordType, button.dataset.recordId);
      });
    });
    this.shadowRoot.querySelector("#hierarchy-search")?.addEventListener("input", (event) => {
      this._hierarchyQuery = event.target.value;
      window.clearTimeout(this._hierarchySearchTimer);
      this._hierarchySearchTimer = window.setTimeout(() => this._loadHierarchy(), 250);
    });
    this.shadowRoot.querySelectorAll("[data-hierarchy-form]").forEach((form) => {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        this._saveHierarchyRecord(form.dataset.hierarchyForm, form);
      });
    });
    this.shadowRoot.querySelectorAll("[data-archive-hierarchy]").forEach((button) => {
      button.addEventListener("click", () => {
        this._archiveHierarchyRecord(button.dataset.recordType, button.dataset.recordId);
      });
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
          <span><b>${session ? htmlEscape(formatDuration(this._liveSessionDuration(session))) : "--"}</b><small>Charging for</small></span>
          <span><b>${session ? htmlEscape(this._formatLiveSessionCost(session, outlet)) : "--"}</b><small>Session cost</small></span>
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
          <span><b>${activeSession ? htmlEscape(formatDuration(this._liveSessionDuration(activeSession))) : "--"}</b><small>Charging for</small></span>
          <span><b>${activeSession ? htmlEscape(this._formatLiveSessionCost(activeSession, outlet)) : "--"}</b><small>Session cost</small></span>
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
    const managementSessions = this._managementReport?.sessions || [];
    return `
      <section class="billing-card">
        <div class="section-head">
          <div>
            <h2>Management Dashboard</h2>
            <p>Operational KPIs from managed outlets, sessions, and local records.</p>
          </div>
          <button id="refresh-management-report">Refresh</button>
        </div>
        ${this._managementMessage ? `<p class="notice">${htmlEscape(this._managementMessage)}</p>` : ""}
        ${this._managementKpis()}
        <section class="report-controls management-filters">
          <label>Billing period<select id="billing-period-select">
            <option value="day" ${this._billingPeriod === "day" ? "selected" : ""}>Today</option>
            <option value="week" ${this._billingPeriod === "week" ? "selected" : ""}>Last 7 days</option>
            <option value="month" ${this._billingPeriod === "month" ? "selected" : ""}>This month</option>
            <option value="all" ${this._billingPeriod === "all" ? "selected" : ""}>All sessions</option>
          </select></label>
          <label>Outlet<select id="report-outlet-filter" data-management-filter>
            <option value="">All outlets</option>
            ${this._outlets.map((outlet) => `<option value="${htmlEscape(outlet.entity.entity_id)}">${htmlEscape(outlet.name)}</option>`).join("")}
          </select></label>
          <label>Status<select id="report-billing-filter" data-management-filter>
            <option value="">All statuses</option>
            ${(this._managementReport?.billing_states || []).map((state) => `<option value="${htmlEscape(state)}">${htmlEscape(state)}</option>`).join("")}
          </select></label>
          <label>Reference<input id="report-reference-filter" data-management-filter placeholder="Customer, bay, ref"></label>
          <button id="download-management-csv" ${managementSessions.length ? "" : "disabled"}>Management CSV</button>
        </section>
        ${this._statementCards(currency)}
        <div class="management-charts">
          ${this._smallSeries("Energy by Day", this._managementReport?.charts?.energy_by_day, "kWh")}
          ${this._smallSeries("Sessions by Day", this._managementReport?.charts?.sessions_by_day, "")}
          ${this._smallSeries("Top Outlets", this._managementReport?.charts?.top_outlets, "kWh")}
          ${this._smallSeries("Costs", this._managementReport?.charts?.costs_and_recoverable_amounts, currency)}
        </div>
      </section>
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

  _managementKpis() {
    const kpis = this._managementReport?.kpis || {};
    const items = [
      ["Managed outlets", kpis.total_managed_outlets],
      ["Available", kpis.available_outlets],
      ["Charging", kpis.active_charging_outlets],
      ["Waiting", kpis.waiting_outlets],
      ["Paused", kpis.load_managed_paused_outlets],
      ["Offline", kpis.offline_outlets],
      ["Faulted", kpis.faulted_outlets],
      ["Sessions today", kpis.sessions_today],
      ["Energy today", formatEnergyKwh(kpis.energy_today, "kWh")],
      ["Energy month", formatEnergyKwh(kpis.energy_this_month, "kWh")],
      ["Recovery", formatCurrency(kpis.estimated_cost_recovery, this._managementReport?.currency || "AUD")],
      ["Peak demand", `${formatNumber(kpis.peak_charging_demand, 0)} W`],
      ["Avg kWh", formatEnergyKwh(kpis.average_kwh_per_session, "kWh")],
      ["Avg duration", formatDuration(kpis.average_charging_duration)],
      ["Utilisation", `${formatNumber(kpis.utilisation_percentage, 1)}%`],
    ];
    return `<section class="management-kpis">${items.map(([label, value]) => `
      <article><span>${htmlEscape(label)}</span><strong>${htmlEscape(value ?? "--")}</strong></article>
    `).join("")}</section>`;
  }

  _statementCards(currency) {
    const statement = this._managementReport?.statement || {};
    const items = [
      ["Measured energy", formatEnergyKwh(statement.total_measured_charging_energy, "kWh")],
      ["Electricity cost", formatCurrency(statement.underlying_electricity_cost, currency)],
      ["Energy charges", formatCurrency(statement.energy_charges, currency)],
      ["Management fees", formatCurrency(statement.management_fees, currency)],
      ["Waived", formatCurrency(statement.waived_sessions, currency)],
      ["Recoverable", formatCurrency(statement.total_recoverable_amount, currency)],
      ["Invoiced", formatCurrency(statement.amount_marked_invoiced, currency)],
      ["Paid", formatCurrency(statement.amount_marked_paid, currency)],
      ["Outstanding", formatCurrency(statement.outstanding_amount, currency)],
    ];
    return `<section class="statement-grid">${items.map(([label, value]) => `
      <article><span>${htmlEscape(label)}</span><strong>${htmlEscape(value)}</strong></article>
    `).join("")}</section>`;
  }

  _smallSeries(title, rows = [], suffix = "") {
    const displayRows = Array.isArray(rows) ? rows.slice(0, 8) : [];
    return `
      <div class="series-card">
        <h2>${htmlEscape(title)}</h2>
        ${displayRows.length ? displayRows.map((row) => `
          <div class="series-row">
            <span>${htmlEscape(row.label)}</span>
            <b>${htmlEscape(suffix === this._managementReport?.currency ? formatCurrency(row.value, suffix) : `${formatNumber(row.value, 2)} ${suffix}`.trim())}</b>
          </div>
        `).join("") : `<div class="empty">No data for this filter.</div>`}
      </div>
    `;
  }

  _recordsView() {
    const customers = this._records?.customers || [];
    const vehicles = this._records?.vehicles || [];
    const groups = this._records?.user_groups || [];
    return `
      <section class="record-tools">
        <label>Search records<input id="record-search" value="${htmlEscape(this._recordQuery)}" placeholder="Name, rego, billing ref"></label>
      </section>
      ${this._recordsError ? `<p class="notice">${htmlEscape(this._recordsError)}</p>` : ""}
      ${this._recordsNotice ? `<p class="notice">${htmlEscape(this._recordsNotice)}</p>` : ""}
      <section class="record-grid">
        <div class="record-panel">
          <h2>Customers</h2>
          <form data-record-form="customer" class="record-form">
            <input name="display_name" placeholder="Display name" required>
            <input name="contact_email" placeholder="Email">
            <input name="contact_telephone" placeholder="Telephone">
            <input name="apartment_unit_company" placeholder="Apartment, unit, or company">
            <input name="billing_reference" placeholder="Billing reference">
            <select name="user_group">
              <option value="">No group</option>
              ${groups.map((group) => `<option value="${htmlEscape(group.id)}">${htmlEscape(group.name)}</option>`).join("")}
            </select>
            <input name="notes" placeholder="Notes">
            <button>Save Customer</button>
          </form>
          <div class="record-list">${customers.map((record) => this._customerRow(record, groups)).join("") || `<div class="empty">No customers found.</div>`}</div>
        </div>
        <div class="record-panel">
          <h2>Vehicles</h2>
          <form data-record-form="vehicle" class="record-form">
            <select name="customer_id">
              <option value="">No customer</option>
              ${customers.map((customer) => `<option value="${htmlEscape(customer.id)}">${htmlEscape(customer.display_name)}</option>`).join("")}
            </select>
            <input name="registration" placeholder="Registration" required>
            <input name="make_model_description" placeholder="Make / model">
            <input name="notes" placeholder="Notes">
            <button>Save Vehicle</button>
          </form>
          <div class="record-list">${vehicles.map((record) => this._vehicleRow(record, customers)).join("") || `<div class="empty">No vehicles found.</div>`}</div>
        </div>
        <div class="record-panel">
          <h2>User Groups</h2>
          <form data-record-form="user_group" class="record-form">
            <input name="name" placeholder="Group name" required>
            <input name="default_tariff" placeholder="Default tariff">
            <input name="priority" type="number" min="0" step="1" placeholder="Priority">
            <input name="discount_percentage" type="number" min="0" max="100" step="0.01" placeholder="Discount %">
            <label class="check"><input name="charging_allowed" type="checkbox" checked> Charging allowed</label>
            <label class="check"><input name="free_charging" type="checkbox"> Free charging</label>
            <button>Save Group</button>
          </form>
          <div class="record-list">${groups.map((record) => this._groupRow(record)).join("") || `<div class="empty">No groups found.</div>`}</div>
        </div>
      </section>
    `;
  }

  _customerRow(record, groups) {
    const group = groups.find((item) => item.id === record.user_group);
    return this._recordRow("customer", record.id, record.display_name, [
      record.apartment_unit_company,
      record.billing_reference,
      group?.name,
      record.contact_email,
    ]);
  }

  _vehicleRow(record, customers) {
    const customer = customers.find((item) => item.id === record.customer_id);
    return this._recordRow("vehicle", record.id, record.registration, [
      record.make_model_description,
      customer?.display_name,
      record.notes,
    ]);
  }

  _groupRow(record) {
    return this._recordRow("user_group", record.id, record.name, [
      `Priority ${record.priority ?? 0}`,
      record.free_charging ? "Free charging" : `${formatNumber(record.discount_percentage || 0, 2)}% discount`,
      record.charging_allowed ? "Allowed" : "Blocked",
    ]);
  }

  _recordRow(recordType, recordId, title, details) {
    return `
      <div class="record-row">
        <span>
          <strong>${htmlEscape(title || recordId)}</strong>
          <small>${details.filter(Boolean).map(htmlEscape).join(" · ")}</small>
        </span>
        <button
          class="secondary"
          data-archive-record
          data-record-type="${htmlEscape(recordType)}"
          data-record-id="${htmlEscape(recordId)}"
        >Archive</button>
      </div>
    `;
  }

  _hierarchyView() {
    const data = this._hierarchy || {};
    const organisations = data.organisations || [];
    const sites = data.sites || [];
    const buildings = data.buildings || [];
    const boards = data.distribution_boards || [];
    const circuits = data.circuit_groups || [];
    const outlets = data.outlet_mappings || [];
    const discovered = data.discovered_outlets || [];
    return `
      <section class="record-tools">
        <label>Search hierarchy<input id="hierarchy-search" value="${htmlEscape(this._hierarchyQuery)}" placeholder="Site, board, circuit, outlet"></label>
      </section>
      ${this._hierarchyError ? `<p class="notice">${htmlEscape(this._hierarchyError)}</p>` : ""}
      ${this._hierarchyNotice ? `<p class="notice">${htmlEscape(this._hierarchyNotice)}</p>` : ""}
      <section class="hierarchy-grid">
        <div class="record-panel">
          <h2>Organisations</h2>
          <form data-hierarchy-form="organisation" class="record-form">
            <input name="name" placeholder="Organisation name" required>
            <input name="billing_reference" placeholder="Billing reference">
            <input name="notes" placeholder="Notes">
            <button>Save Organisation</button>
          </form>
          <div class="record-list">${organisations.map((record) => this._hierarchyRow("organisation", record.id, record.name, [record.billing_reference, record.notes])).join("") || `<div class="empty">No organisations yet.</div>`}</div>
        </div>
        <div class="record-panel">
          <h2>Sites</h2>
          <form data-hierarchy-form="site" class="record-form">
            ${this._select("organisation_id", "No organisation", organisations, "name")}
            <input name="name" placeholder="Site name" required>
            <input name="address" placeholder="Address">
            <input name="timezone" placeholder="Timezone">
            <input name="notes" placeholder="Notes">
            <button>Save Site</button>
          </form>
          <div class="record-list">${sites.map((record) => this._hierarchyRow("site", record.id, record.name, [this._nameById(organisations, record.organisation_id), record.address])).join("") || `<div class="empty">No sites yet.</div>`}</div>
        </div>
        <div class="record-panel">
          <h2>Buildings / Levels</h2>
          <form data-hierarchy-form="building" class="record-form">
            ${this._select("site_id", "No site", sites, "name")}
            <input name="name" placeholder="Building or level name" required>
            <input name="ha_floor_id" placeholder="HA floor id">
            <input name="notes" placeholder="Notes">
            <button>Save Building</button>
          </form>
          <div class="record-list">${buildings.map((record) => this._hierarchyRow("building", record.id, record.name, [this._nameById(sites, record.site_id), record.ha_floor_id])).join("") || `<div class="empty">No buildings or levels yet.</div>`}</div>
        </div>
        <div class="record-panel">
          <h2>Distribution Boards</h2>
          <form data-hierarchy-form="distribution_board" class="record-form">
            ${this._select("building_id", "No building", buildings, "name")}
            <input name="name" placeholder="Board name" required>
            ${this._electricalInputs()}
            <input name="main_meter_power_entity" placeholder="Main meter power entity">
            <label class="check"><input name="enabled" type="checkbox" checked> Enabled</label>
            <input name="notes" placeholder="Notes">
            <button>Save Board</button>
          </form>
          <div class="record-list">${boards.map((record) => this._hierarchyRow("distribution_board", record.id, record.name, [this._nameById(buildings, record.building_id), this._electricalSummary(record), record.enabled === false ? "Disabled" : "Enabled"])).join("") || `<div class="empty">No distribution boards yet.</div>`}</div>
        </div>
        <div class="record-panel">
          <h2>Circuit Groups</h2>
          <form data-hierarchy-form="circuit_group" class="record-form">
            ${this._select("distribution_board_id", "No board", boards, "name")}
            <input name="name" placeholder="Circuit group name" required>
            ${this._electricalInputs()}
            <input name="maximum_simultaneous_outlets" type="number" min="0" step="1" placeholder="Max simultaneous outlets">
            <select name="load_management_mode">
              <option value="monitor_only">Monitor only</option>
              <option value="first_in_first_out">First in first out</option>
              <option value="priority">Priority</option>
              <option value="manual">Manual</option>
            </select>
            <input name="allocation_interval" type="number" min="0" step="1" placeholder="Allocation interval seconds">
            <input name="minimum_relay_on_duration" type="number" min="0" step="1" placeholder="Minimum relay-on seconds">
            <input name="minimum_relay_off_duration" type="number" min="0" step="1" placeholder="Minimum relay-off seconds">
            <input name="maximum_relay_operations_per_hour" type="number" min="0" step="1" placeholder="Max relay operations/hour">
            <input name="priority" type="number" min="0" step="1" placeholder="Priority">
            <input name="main_meter_power_entity" placeholder="Main meter power entity">
            <label class="check"><input name="enabled" type="checkbox" checked> Enabled</label>
            <button>Save Circuit</button>
          </form>
          <div class="record-list">${circuits.map((record) => this._hierarchyRow("circuit_group", record.id, record.name, [this._nameById(boards, record.distribution_board_id), this._electricalSummary(record), `${record.maximum_simultaneous_outlets ?? "--"} simultaneous`])).join("") || `<div class="empty">No circuit groups yet.</div>`}</div>
        </div>
        <div class="record-panel">
          <h2>Outlet Assignments</h2>
          <form data-hierarchy-form="outlet" class="record-form">
            <select name="switch_entity_id" required>
              <option value="">Select discovered outlet</option>
              ${discovered.map((outlet) => `<option value="${htmlEscape(outlet.switch_entity_id)}">${htmlEscape(outlet.switch_name || outlet.switch_entity_id)}</option>`).join("")}
            </select>
            ${this._select("site_id", "No site", sites, "name")}
            ${this._select("building_id", "No building", buildings, "name")}
            ${this._select("distribution_board_id", "No board", boards, "name")}
            ${this._select("circuit_group_id", "No circuit", circuits, "name")}
            <input name="level" placeholder="Level">
            <input name="area" placeholder="Area">
            <input name="bay" placeholder="Bay / car park spot">
            <input name="power_entity_id" placeholder="Power entity override">
            <input name="energy_entity_id" placeholder="Energy entity override">
            <input name="ha_label_ids" placeholder="HA labels, comma separated">
            <button>Assign Outlet</button>
          </form>
          <div class="record-list">${outlets.map((record) => this._hierarchyRow("outlet", record.id, record.switch_entity_id, [record.bay, this._nameById(circuits, record.circuit_group_id), record.power_entity_id, record.energy_entity_id])).join("") || `<div class="empty">No outlet assignments yet.</div>`}</div>
        </div>
      </section>
    `;
  }

  _select(name, emptyLabel, rows, labelKey) {
    return `<select name="${htmlEscape(name)}"><option value="">${htmlEscape(emptyLabel)}</option>${rows.map((row) => `<option value="${htmlEscape(row.id)}">${htmlEscape(row[labelKey] || row.id)}</option>`).join("")}</select>`;
  }

  _nameById(rows, id) {
    return rows.find((row) => row.id === id)?.name || "";
  }

  _electricalInputs() {
    return `
      <input name="maximum_current" type="number" min="0" step="0.01" placeholder="Maximum current A">
      <input name="maximum_power" type="number" min="0" step="0.01" placeholder="Maximum power W">
      <input name="reserve_margin" type="number" min="0" step="0.01" placeholder="Reserve margin W">
      <input name="warning_threshold" type="number" min="0" step="0.01" placeholder="Warning threshold W">
    `;
  }

  _electricalSummary(record) {
    const bits = [];
    if (record.maximum_current != null) bits.push(`${formatNumber(record.maximum_current, 1)} A`);
    if (record.maximum_power != null) bits.push(`${formatNumber(record.maximum_power, 0)} W max`);
    if (record.warning_threshold != null) bits.push(`${formatNumber(record.warning_threshold, 0)} W warning`);
    return bits.join(" · ");
  }

  _hierarchyRow(recordType, recordId, title, details) {
    return `
      <div class="record-row">
        <span>
          <strong>${htmlEscape(title || recordId)}</strong>
          <small>${details.filter(Boolean).map(htmlEscape).join(" · ")}</small>
        </span>
        <button
          class="secondary"
          data-archive-hierarchy
          data-record-type="${htmlEscape(recordType)}"
          data-record-id="${htmlEscape(recordId)}"
        >Archive</button>
      </div>
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
      .management-filters { margin-top: 12px; }
      label { display: grid; gap: 6px; color: #5d6972; font-size: 13px; }
      select, input { min-width: 220px; border: 1px solid #cfd8de; border-radius: 7px; padding: 9px 10px; background: #fff; color: #172026; }
      input[type="checkbox"] { min-width: 0; width: auto; }
      .report-card { padding: 16px; min-height: 360px; }
      .management-kpis { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; margin-top: 12px; }
      .management-kpis article, .statement-grid article { border-color: #edf0f2; box-shadow: none; }
      .management-kpis strong, .statement-grid strong { font-size: 20px; }
      .statement-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 12px 0; }
      .management-charts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
      .series-card { border: 1px solid #edf0f2; border-radius: 8px; padding: 12px; }
      .series-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; padding: 7px 0; border-top: 1px solid #edf0f2; }
      .series-row span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #5d6972; }
      .record-tools { margin-bottom: 14px; }
      .record-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; align-items: start; }
      .hierarchy-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; align-items: start; }
      .record-panel { display: grid; gap: 12px; background: #fff; border: 1px solid #dde3e7; border-radius: 8px; padding: 16px; }
      .record-form { display: grid; gap: 8px; }
      .record-form select, .record-form input { min-width: 0; width: 100%; box-sizing: border-box; }
      .check { display: flex; align-items: center; gap: 8px; color: #172026; }
      .record-list { display: grid; gap: 8px; }
      .record-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; border-top: 1px solid #edf0f2; padding-top: 9px; }
      .record-row span { min-width: 0; }
      .record-row strong, .record-row small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
        .summary-grid, .billing-summary, .management-kpis, .statement-grid, .management-charts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .record-grid, .hierarchy-grid { grid-template-columns: 1fr; }
        .master-control, .audit-row, .rename-row, .billing-row, .aggregate-row { grid-template-columns: 1fr; }
        .outlet-actions { display: grid; }
        select, input { min-width: 0; width: 100%; box-sizing: border-box; }
      }
    `;
  }
}

customElements.define("pow-reporting-panel", PowReportingPanel);
