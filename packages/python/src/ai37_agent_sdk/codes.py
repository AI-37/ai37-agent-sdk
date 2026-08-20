# СГЕНЕРИРОВАНО scripts/codegen.mjs из contract/feature-codes.json. НЕ редактировать вручную.
from enum import Enum

class BillingFeatureCode(str, Enum):
    ElevatorCalcAgent = "elevator-calc-agent"
    MinstroyAgent = "minstroy-agent"
    PdaiDoc152Fz = "pdai-doc-152fz"
    PdaiDoc187Fz = "pdai-doc-187fz"
    PdaiSiteCheck = "pdai-site-check"
    ThermalCalcAgent = "thermal-calc-agent"


class BillingPrivilegeCode(str, Enum):
    ElevatorCalcAllowed = "elevator-calc-allowed"
    MinstroyCheckInn = "minstroy-check-inn"
    PdaiDoc152FzAllowed = "pdai-doc-152fz-allowed"
    PdaiDoc187FzAllowed = "pdai-doc-187fz-allowed"
    PdaiSiteCheckAllowed = "pdai-site-check-allowed"
    ThermalCalcAllowed = "thermal-calc-allowed"
