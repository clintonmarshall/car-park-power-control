"""Constants for Adaptive Services ParkPower."""

DOMAIN = "pow_reporting"

CONF_DASHBOARD_NAME = "dashboard_name"
CONF_LOGO_URL = "logo_url"
CONF_SIDEBAR_ICON = "sidebar_icon"
CONF_URL_PATH = "url_path"
CONF_ENTITY_FILTER = "entity_filter"
CONF_ENABLE_CUSTOMER_PORTAL = "enable_customer_portal"
CONF_PORTAL_NAME = "portal_name"
CONF_PORTAL_URL_PATH = "portal_url_path"

DEFAULT_DASHBOARD_NAME = "Adaptive Services ParkPower"
DEFAULT_PORTAL_NAME = "ParkPower Portal"
DEFAULT_SIDEBAR_ICON = "mdi:chart-line"
DEFAULT_URL_PATH = "parkpower"
DEFAULT_PORTAL_URL_PATH = "parkpower-portal"
DEFAULT_ENTITY_FILTER = "sonoff,pow,esphome"

PANEL_JS_URL = f"/api/{DOMAIN}/static/pow-reporting-panel.js"
