"""Constants for Sonoff POW Energy Reporter."""

DOMAIN = "pow_reporting"

CONF_DASHBOARD_NAME = "dashboard_name"
CONF_LOGO_URL = "logo_url"
CONF_SIDEBAR_ICON = "sidebar_icon"
CONF_URL_PATH = "url_path"
CONF_ENTITY_FILTER = "entity_filter"

DEFAULT_DASHBOARD_NAME = "Power Reporting"
DEFAULT_SIDEBAR_ICON = "mdi:chart-line"
DEFAULT_URL_PATH = "pow-reporting"
DEFAULT_ENTITY_FILTER = "sonoff,pow,esphome"

PANEL_JS_URL = f"/api/{DOMAIN}/static/pow-reporting-panel.js"

