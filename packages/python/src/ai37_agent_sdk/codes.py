# СГЕНЕРИРОВАНО scripts/codegen.mjs из contract/feature-codes.json. НЕ редактировать вручную.
from enum import Enum

class BillingFeatureCode(str, Enum):
    ElevatorCalcAgent = "elevator-calc-agent"
    MinstroyAgent = "minstroy-agent"
    ThermalCalcAgent = "thermal-calc-agent"


class BillingPrivilegeCode(str, Enum):
    ElevatorCalcAllowed = "elevator-calc-allowed"
    MinstroyCheckInn = "minstroy-check-inn"
    ThermalCalcAllowed = "thermal-calc-allowed"
