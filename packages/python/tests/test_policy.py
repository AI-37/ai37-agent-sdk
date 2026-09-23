from ai37_agent_sdk import PolicyStateOptions, parse_policy_state, read_policy_state

ADMIN = PolicyStateOptions(states=("relaxed", "attributed", "closed"), fallback="closed")


def test_accepts_a_declared_state():
    for state in ADMIN.states:
        assert parse_policy_state(state, ADMIN) == state


def test_absence_empty_string_and_spaces_fall_back():
    assert parse_policy_state(None, ADMIN) == "closed"
    assert parse_policy_state("", ADMIN) == "closed"
    assert parse_policy_state("   ", ADMIN) == "closed"


def test_unrecognized_falls_back_instead_of_guessing():
    assert parse_policy_state("relaxedd", ADMIN) == "closed"
    assert parse_policy_state("RELAXED", ADMIN) == "closed"
    assert parse_policy_state(42, ADMIN) == "closed"


def test_spaces_around_a_good_value_are_trimmed():
    assert parse_policy_state(" relaxed ", ADMIN) == "relaxed"


def test_the_set_of_states_belongs_to_the_caller():
    route = PolicyStateOptions(states=("relaxed", "trusted", "closed"), fallback="closed")
    assert parse_policy_state("trusted", route) == "trusted"
    assert parse_policy_state("attributed", route) == "closed"


def test_the_relaxed_side_can_be_the_default_too():
    relaxed_by_default = PolicyStateOptions(states=ADMIN.states, fallback="relaxed")
    assert parse_policy_state("", relaxed_by_default) == "relaxed"


def test_reads_an_arbitrarily_named_variable():
    env = {"ADMIN_CONTENT_READ": "attributed"}
    assert read_policy_state("ADMIN_CONTENT_READ", ADMIN, env) == "attributed"


def test_unset_variable_gives_the_fallback():
    assert read_policy_state("ADMIN_CONTENT_READ", ADMIN, {}) == "closed"
