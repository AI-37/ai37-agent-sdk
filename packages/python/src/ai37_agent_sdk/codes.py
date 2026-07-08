# СГЕНЕРИРОВАНО scripts/codegen.mjs из contract/feature-codes.json. НЕ редактировать вручную.
from enum import Enum

class BillingFeatureCode(str, Enum):
    ElevatorCalcAgent = "elevator-calc-agent"
    ThermalCalcAgent = "thermal-calc-agent"


class BillingPrivilegeCode(str, Enum):
    ElevatorCalcAllowed = "elevator-calc-allowed"
    ThermalCalcAllowed = "thermal-calc-allowed"
