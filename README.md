# Adaptive Services ParkPower

A HACS-ready Home Assistant custom integration for commercial-style monitoring of
ESPHome/Sonoff POW power and energy devices in managed car park charging
outlet deployments.

The integration adds a sidebar panel with:

- automatic discovery of likely power and energy entities
- automatic discovery of likely outlet relay switches
- individual outlet power control
- a master **ALL Off** control
- customer, bay, booking, or car park spot references before energising an
  outlet
- centrally stored outlet on/off audit logs with timestamps
- persisted charging sessions and billing reports stored in Home Assistant
- local customer, vehicle, and user-group records
- formal charging-session state tracking for future tariff/load-management work
- configurable energy rate and currency for billing reports
- live charge timers on managed outlets
- current load, total energy, and per-device/entity summaries
- daily, weekly, monthly, and custom-range reports
- management KPIs, report filters, chart-ready summaries, and monthly statement
  totals
- charting from Home Assistant recorder statistics when available
- CSV export for energy statistics, outlet power events, and billing sessions
- local dashboard branding controls for name, logo URL, and accent color

## Install with HACS

1. Publish this repository to GitHub.
2. In Home Assistant, open HACS.
3. Add `https://github.com/clintonmarshall/ParkPower` as a custom
   repository with category `Integration`.
4. Install `Adaptive Services ParkPower`.
5. Restart Home Assistant.
6. Go to **Settings > Devices & services > Add integration** and add
   `Adaptive Services ParkPower`.

## Local/manual install

Copy `custom_components/pow_reporting` into your Home Assistant
`config/custom_components/` directory, restart Home Assistant, then add the
integration from the UI.

## Branding

The first version stores branding in the browser using local storage. Open the
dashboard, choose the settings tab, and set:

- dashboard name
- logo URL
- accent color
- entity filter

For a commercial deployment, the next step should be moving those options into
the integration options flow so they are managed centrally in Home Assistant.

## Outlet Audit Log

Outlet control events are stored on the Home Assistant instance using Home
Assistant storage. Each record includes:

- local timestamp
- outlet name
- switch entity id
- action: `turn_on` or `turn_off`
- operator-entered reference
- success/failure state

The dashboard requires a reference before turning an outlet on. Turning an
outlet off reuses the active reference where available. The master **ALL Off**
action logs one off event per managed outlet.

### Home Assistant Entity Naming

The HACS dashboard Settings tab includes a **Home Assistant Entity Naming** tool.
It previews and then optionally applies display names based on HA Floor, Area,
and Bay/Spot labels.

For example, a device on `Level 1` with label `Bay 7` is named:

- `L1-B7 Control` for the outlet switch
- `L1-B7 Watts` for power
- `L1-B7 Amps` for current
- `L1-B7 Voltage` for voltage
- `L1-B7 Wh` for energy
- `L1-B7 Daily Wh` for daily energy, where present

The tool changes Home Assistant entity display names only. It does not rename
raw `entity_id` values, which keeps existing automations, history, and dashboards
safer.

## Self-contained HACS Portal

The operational portal is served by the HACS custom integration as a Home
Assistant sidebar panel. No separate Node/Express service is required for a
fresh Home Assistant installation.

By default it registers two Home Assistant routes on port `8123`:

- `/parkpower` for the admin dashboard, outlet controls, settings, entity
  naming tools, and reports
- `/parkpower-portal` for the customer-style charging portal view

For example:

```text
http://homeassistant.local:8123/parkpower
http://homeassistant.local:8123/parkpower-portal
```

Both routes are served by Home Assistant and use Home Assistant authentication.
That is intentional for the HACS package. A public customer portal should be a
separate tokenized/share-link route so outlet state and control permissions are
not exposed accidentally.

The panel stores charge sessions and billing settings in Home Assistant storage
under `.storage/pow_reporting.billing`. Outlet audit events are stored under
`.storage/pow_reporting.outlet_log`.

Phase 1/2 managed session and customer records are stored under
`.storage/pow_reporting.sessions`. This schema is additive so existing billing
and audit data remains valid.

Charging sessions are recorded when outlets are controlled through the HACS
panel:

- Power On records the reference, start time, current energy meter reading, and
  current rate.
- Power Off records end time, end meter reading, duration, kWh used, and cost.
- Master ALL Off completes active sessions for every outlet it successfully
  turns off.

Home Assistant Recorder remains the source for raw sensor history and charting.
The HACS integration owns the commercial/session context: reference, rate,
start/end readings, and billing totals.

### Managed Records

The dashboard **Records** tab stores lightweight local records for:

- Customers: name, contact details, apartment/unit/company, billing reference,
  user group, status, and notes
- Vehicles: linked customer, registration, make/model description, and notes
- User groups: default tariff placeholder, priority, charging allowed, free
  charging, and discount percentage

The existing free-text outlet reference remains available. Customer and vehicle
selectors will be added to the outlet start workflow before tariff profiles are
applied.

### Session State Tracking

Alongside the existing billing session list, ParkPower now keeps a richer
managed-session ledger with states such as `waiting_for_load`, `charging`,
`idle_grace_period`, `completed`, `cancelled`, and `requires_review`.

Configurable thresholds control delayed charging start/stop detection:

- `charging_start_watts`
- `charging_start_delay_seconds`
- `charging_stop_watts`
- `charging_stop_delay_minutes`
- `maximum_session_hours`
- `meter_stale_minutes`
- `offline_timeout_minutes`

The integration listens to matched Home Assistant power and energy sensors so
live readings can advance sessions from waiting, to charging, to completed.

### Management Reports

The dashboard **Reports** tab includes Phase 4 management reporting:

- total managed, available, charging, waiting, paused, offline, and faulted
  outlets
- sessions today, energy today, monthly energy, estimated recovery, live demand,
  average kWh, average duration, and utilisation
- filters for period, outlet, billing status, and reference text
- chart-ready summaries for energy by day, sessions by day, top outlets, costs,
  and live outlet load
- CSV export for filtered management sessions
- monthly-style statement totals for measured energy, electricity cost,
  recoverable amount, invoiced, paid, waived, and outstanding values

Tariff-specific reporting columns are intentionally prepared but not fully
calculated until tariff profiles are added in Phase 3.

### Outlet Mapping

The HACS portal reads Home Assistant registries for outlet metadata:

- Home Assistant **Area** becomes the portal area, such as `L1 Parking`
- The Area's Home Assistant **Floor** becomes the portal level, such as `Level 1`
- Home Assistant **Labels** named like `Bay 7`, `Spot 014`, or `Space A12`
  become the portal bay/spot

Assign the ESPHome/Sonoff device to an Area in Home Assistant, put that Area on
a Floor, and add a Bay/Spot label to the device or switch entity. The HACS panel
will pick those changes up on the next refresh.

## ESP Display Panel

The `display/parking_power_panel/` folder contains first-pass Arduino/LVGL
firmware for the JC1060P470C_I_W_Y 7 inch ESP32-P4 display.

It provides:

- live total load / outlets on / energy today summary
- parking spot lookup with on-screen keypad
- outlet detail screen
- power on/off controls through the Home Assistant API

The display firmware is still a companion client. The core portal, reporting,
and billing logic lives inside the HACS integration.

## Notes

The dashboard reads Home Assistant entity/device registries and recorder
statistics through the frontend WebSocket connection. The recorder statistics
calls are used defensively because Home Assistant does not publish them as a
stable public REST API.
