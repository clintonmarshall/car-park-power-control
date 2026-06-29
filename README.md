# Car Park Power Control

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
- current load, total energy, and per-device/entity summaries
- daily, weekly, monthly, and custom-range reports
- charting from Home Assistant recorder statistics when available
- CSV export for energy statistics and outlet power events
- local dashboard branding controls for name, logo URL, and accent color

## Install with HACS

1. Publish this repository to GitHub.
2. In Home Assistant, open HACS.
3. Add `https://github.com/clintonmarshall/car-park-power-control` as a custom
   repository with category `Integration`.
4. Install `Car Park Power Control`.
5. Restart Home Assistant.
6. Go to **Settings > Devices & services > Add integration** and add
   `Sonoff POW Energy Reporter`.

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

## Notes

The dashboard reads Home Assistant entity/device registries and recorder
statistics through the frontend WebSocket connection. The recorder statistics
calls are used defensively because Home Assistant does not publish them as a
stable public REST API.
