# СГЕНЕРИРОВАНО scripts/codegen.mjs из contract/feature-codes.json. НЕ редактировать вручную.
from enum import Enum

class BillingFeatureCode(str, Enum):
    DaylightCalcAgent = "daylight-calc-agent"
    ElevatorCalcAgent = "elevator-calc-agent"
    HvacCalcAgent = "hvac-calc-agent"
    MinstroyAgent = "minstroy-agent"
    OrgLimits = "org-limits"
    PdaiDoc152Fz = "pdai-doc-152fz"
    PdaiDoc187Fz = "pdai-doc-187fz"
    PdaiSiteCheck = "pdai-site-check"
    ThermalCalcAgent = "thermal-calc-agent"


class BillingPrivilegeCode(str, Enum):
    DaylightCalcAllowed = "daylight-calc-allowed"
    ElevatorCalcAllowed = "elevator-calc-allowed"
    HvacAirExchangeAllowed = "hvac-air-exchange-allowed"
    HvacCalcAllowed = "hvac-calc-allowed"
    HvacHeatLossAllowed = "hvac-heat-loss-allowed"
    MaxApiKeys = "max-api-keys"
    MaxUsers = "max-users"
    MinstroyCheckInn = "minstroy-check-inn"
    MinstroyPriceMonitoring = "minstroy-price-monitoring"
    PdaiDoc152FzAllowed = "pdai-doc-152fz-allowed"
    PdaiDoc187FzAllowed = "pdai-doc-187fz-allowed"
    PdaiSiteCheckAllowed = "pdai-site-check-allowed"
    ThermalCalcAllowed = "thermal-calc-allowed"
