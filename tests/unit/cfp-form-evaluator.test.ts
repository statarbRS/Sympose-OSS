import { describe, expect, it } from "vitest";
import {
  evaluateConditionalForm,
  FORM_COMPARISON_OPERATORS,
  FORM_RULE_LIMITS,
  FORM_RULES_SCHEMA,
  FormEvaluationError,
  FormEvaluatorError,
  normalizeFormRuleSet,
  type FormComparisonOperator,
  type FormEvaluationErrorCode,
  type FormFieldState,
} from "../../src/server/services/cfp/form-evaluator";
import { compareFormFieldIds } from "../../src/server/services/cfp/form-types";

function field(
  id: string,
  type: string = "shortText",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    type,
    label: `Label for ${id}`,
    required: false,
    defaultVisibility: "visible",
    ...overrides,
  };
}

function answer(fieldId: string, value: unknown): Record<string, unknown> {
  return { fieldId, value };
}

function rule(id: string, condition: unknown, actions: unknown[]): Record<string, unknown> {
  return { id, condition, actions };
}

function action(type: string, targetFieldId: string): Record<string, unknown> {
  return { type, targetFieldId };
}

function fieldCond(fieldId: string, operator: string, value?: unknown): Record<string, unknown> {
  return value !== undefined
    ? { kind: "field", fieldId, operator, value }
    : { kind: "field", fieldId, operator };
}

function ruleSet(rules: unknown[], ruleVersionId: string = "rules-v1"): Record<string, unknown> {
  return { schema: FORM_RULES_SCHEMA, ruleVersionId, rules };
}

function captureError(fn: () => unknown): FormEvaluationError {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(FormEvaluationError);
  return thrown as FormEvaluationError;
}

function expectError(fn: () => unknown, code: FormEvaluationErrorCode): void {
  const err = captureError(fn);
  expect(err.code).toBe(code);
}

describe("CFP Form Evaluator - Group 1: Public Interface, Return Contract & Input Validation", () => {
  it("emits exact public result shape and 6-property fieldStates enforcing all boolean implications", () => {
    const fields = [
      field("f1", "shortText", { defaultVisibility: "visible", required: true }),
      field("f2", "shortText", { defaultVisibility: "hidden", required: false }),
    ];
    const rules = ruleSet(
      [rule("r1", fieldCond("f1", "isNotEmpty"), [action("skip", "f2")])],
      "rule-ver-100",
    );
    const history = [answer("f1", "value")];

    const result = evaluateConditionalForm({ fields, historicalAnswers: history, ruleSet: rules });

    expect(result).toHaveProperty("schema", FORM_RULES_SCHEMA);
    expect(result).toHaveProperty("ruleVersionId", "rule-ver-100");
    expect(result).toHaveProperty("fieldStates");
    expect(result).toHaveProperty("hiddenFieldIds");
    expect(result).toHaveProperty("disabledFieldIds");
    expect(result).toHaveProperty("requiredFieldIds");
    expect(result).toHaveProperty("skippedFieldIds");
    expect(result).toHaveProperty("effectiveAnswers");

    const allowedResultKeys = new Set([
      "schema",
      "ruleVersionId",
      "fieldStates",
      "hiddenFieldIds",
      "disabledFieldIds",
      "requiredFieldIds",
      "skippedFieldIds",
      "effectiveAnswers",
    ]);
    expect(Object.keys(result).every((k) => allowedResultKeys.has(k))).toBe(true);

    expect(result.fieldStates).toHaveLength(2);

    for (const state of result.fieldStates) {
      expect(Object.keys(state).sort()).toEqual([
        "editable",
        "effective",
        "fieldId",
        "required",
        "skipped",
        "visible",
      ]);

      expect("visibility" in state).toBe(false);
      expect("enabled" in state).toBe(false);

      expect(state.effective).toBe(state.visible && !state.skipped);
      if (state.editable) {
        expect(state.effective).toBe(true);
      }
      if (state.required) {
        expect(state.editable).toBe(true);
        expect(state.effective).toBe(true);
      }
      if (state.skipped) {
        expect(state.visible).toBe(false);
        expect(state.effective).toBe(false);
        expect(state.editable).toBe(false);
        expect(state.required).toBe(false);
      }
    }
  });

  it("pins sealed display-order ID lists and includes structural rows without treating them as answers", () => {
    const fields = [
      field("trigger"),
      field("hidden", "shortText", { defaultVisibility: "hidden" }),
      field("disabled"),
      field("required", "shortText", { required: true }),
      field("skipped"),
      field("structural", "section"),
    ];
    const condition = fieldCond("trigger", "isNotEmpty");
    const rules = ruleSet([
      rule("r_hidden", condition, [action("hide", "hidden")]),
      rule("r_disabled", condition, [action("disable", "disabled")]),
      rule("r_skipped", condition, [action("skip", "skipped")]),
    ]);

    const result = evaluateConditionalForm({
      fields,
      historicalAnswers: [answer("trigger", "go")],
      ruleSet: rules,
    });

    expect(result.fieldStates.map((state) => state.fieldId)).toEqual([
      "trigger",
      "hidden",
      "disabled",
      "required",
      "skipped",
      "structural",
    ]);
    expect(result.fieldStates.find((state) => state.fieldId === "structural")).toEqual({
      fieldId: "structural",
      visible: true,
      effective: true,
      editable: true,
      required: false,
      skipped: false,
    });
    expect(result.hiddenFieldIds).toEqual(["hidden", "skipped"]);
    expect(result.disabledFieldIds).toEqual(["disabled"]);
    expect(result.requiredFieldIds).toEqual(["required"]);
    expect(result.skippedFieldIds).toEqual(["skipped"]);
    expect(result.effectiveAnswers.map((item) => item.fieldId)).toEqual(["trigger"]);
    expect(result.effectiveAnswers.some((item) => item.fieldId === "structural")).toBe(false);

    for (const ids of [
      result.hiddenFieldIds,
      result.disabledFieldIds,
      result.requiredFieldIds,
      result.skippedFieldIds,
    ]) {
      expect(Object.isFrozen(ids)).toBe(true);
    }
  });

  it("rejects omitted or extra keys in FormEvaluationInput with FORM_INPUT_SHAPE_INVALID", () => {
    const fields = [field("f1")];
    const rules = ruleSet([]);
    const history = [answer("f1", "val")];

    expectError(
      () => evaluateConditionalForm({ fields, historicalAnswers: history }),
      "FORM_INPUT_SHAPE_INVALID",
    );
    expectError(
      () => evaluateConditionalForm({ fields, ruleSet: rules }),
      "FORM_INPUT_SHAPE_INVALID",
    );
    expectError(
      () => evaluateConditionalForm({ historicalAnswers: history, ruleSet: rules }),
      "FORM_INPUT_SHAPE_INVALID",
    );
    expectError(
      () => evaluateConditionalForm({ fields, historicalAnswers: history, ruleSet: rules, extraProp: 123 }),
      "FORM_INPUT_SHAPE_INVALID",
    );
  });

  it("rejects missing or invalid ruleVersionId in FormRuleSet with FORM_RULE_VERSION_ID_INVALID through both entry points", () => {
    const fields = [field("f1")];

    const noVerRuleSet = { schema: FORM_RULES_SCHEMA, rules: [] };
    expectError(
      () => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: noVerRuleSet }),
      "FORM_RULE_VERSION_ID_INVALID",
    );
    expectError(
      () => normalizeFormRuleSet(noVerRuleSet, fields),
      "FORM_RULE_VERSION_ID_INVALID",
    );

    const badVerRuleSet = { schema: FORM_RULES_SCHEMA, ruleVersionId: "invalid version id", rules: [] };
    expectError(
      () => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: badVerRuleSet }),
      "FORM_RULE_VERSION_ID_INVALID",
    );
    expectError(
      () => normalizeFormRuleSet(badVerRuleSet, fields),
      "FORM_RULE_VERSION_ID_INVALID",
    );
  });

  it("enforces mandatory fields in normalizeFormRuleSet signature and parser", () => {
    const rules = ruleSet([]);
    expectError(() => normalizeFormRuleSet(rules, {}), "FORM_FIELD_INVALID");
    expectError(() => normalizeFormRuleSet(rules, "invalid_fields"), "FORM_FIELD_INVALID");
  });
});

describe("CFP Form Evaluator - Group 2: Exhaustive State, Action, Composition & Recovery Matrix", () => {
  it("pins baseline visible, hidden, and required rows and each action individually", () => {
    const fields = [
      field("base_vis", "shortText", { defaultVisibility: "visible", required: false }),
      field("base_hid", "shortText", { defaultVisibility: "hidden", required: false }),
      field("base_req", "shortText", { defaultVisibility: "visible", required: true }),
      field("trig", "shortText", { defaultVisibility: "visible" }),
      field("act_show", "shortText", { defaultVisibility: "hidden" }),
      field("act_hide", "shortText", { defaultVisibility: "visible" }),
      field("act_enable", "shortText", { defaultVisibility: "visible" }),
      field("act_disable", "shortText", { defaultVisibility: "visible" }),
      field("act_require", "shortText", { defaultVisibility: "visible", required: false }),
      field("act_skip", "shortText", { defaultVisibility: "visible" }),
    ];

    const rules = ruleSet([
      rule("r_show", fieldCond("trig", "isNotEmpty"), [action("show", "act_show")]),
      rule("r_hide", fieldCond("trig", "isNotEmpty"), [action("hide", "act_hide")]),
      rule("r_enable", fieldCond("trig", "isNotEmpty"), [action("enable", "act_enable")]),
      rule("r_disable", fieldCond("trig", "isNotEmpty"), [action("disable", "act_disable")]),
      rule("r_require", fieldCond("trig", "isNotEmpty"), [action("require", "act_require")]),
      rule("r_skip", fieldCond("trig", "isNotEmpty"), [action("skip", "act_skip")]),
    ]);

    const res = evaluateConditionalForm({
      fields,
      historicalAnswers: [answer("trig", "active")],
      ruleSet: rules,
    });

    const get = (id: string) => res.fieldStates.find((s) => s.fieldId === id)!;

    expect(get("base_vis")).toEqual({ fieldId: "base_vis", visible: true, effective: true, editable: true, required: false, skipped: false });
    expect(get("base_hid")).toEqual({ fieldId: "base_hid", visible: false, effective: false, editable: false, required: false, skipped: false });
    expect(get("base_req")).toEqual({ fieldId: "base_req", visible: true, effective: true, editable: true, required: true, skipped: false });

    expect(get("act_show")).toEqual({ fieldId: "act_show", visible: true, effective: true, editable: true, required: false, skipped: false });
    expect(get("act_hide")).toEqual({ fieldId: "act_hide", visible: false, effective: false, editable: false, required: false, skipped: false });
    expect(get("act_enable")).toEqual({ fieldId: "act_enable", visible: true, effective: true, editable: true, required: false, skipped: false });
    expect(get("act_disable")).toEqual({ fieldId: "act_disable", visible: true, effective: true, editable: false, required: false, skipped: false });
    expect(get("act_require")).toEqual({ fieldId: "act_require", visible: true, effective: true, editable: true, required: true, skipped: false });
    expect(get("act_skip")).toEqual({ fieldId: "act_skip", visible: false, effective: false, editable: false, required: false, skipped: true });
  });

  it("evaluates enable/require on hidden and disabled fields and all action compositions", () => {
    const fields = [
      field("trig", "shortText"),
      field("hid_en", "shortText", { defaultVisibility: "hidden" }),
      field("hid_req", "shortText", { defaultVisibility: "hidden" }),
      field("dis_req", "shortText", { defaultVisibility: "visible" }),
      field("show_dis", "shortText", { defaultVisibility: "hidden" }),
      field("show_req", "shortText", { defaultVisibility: "hidden" }),
      field("hide_dis", "shortText", { defaultVisibility: "visible" }),
      field("skip_show", "shortText", { defaultVisibility: "hidden" }),
      field("skip_hide", "shortText", { defaultVisibility: "visible" }),
      field("skip_dis", "shortText", { defaultVisibility: "visible" }),
    ];

    const rules = ruleSet([
      rule("r_hid_en", fieldCond("trig", "isNotEmpty"), [action("enable", "hid_en")]),
      rule("r_hid_req", fieldCond("trig", "isNotEmpty"), [action("require", "hid_req")]),
      rule("r_dis_req", fieldCond("trig", "isNotEmpty"), [action("disable", "dis_req"), action("require", "dis_req")]),
      rule("r_show_dis", fieldCond("trig", "isNotEmpty"), [action("show", "show_dis"), action("disable", "show_dis")]),
      rule("r_show_req", fieldCond("trig", "isNotEmpty"), [action("show", "show_req"), action("require", "show_req")]),
      rule("r_hide_dis", fieldCond("trig", "isNotEmpty"), [action("hide", "hide_dis"), action("disable", "hide_dis")]),
      rule("r_skip_show", fieldCond("trig", "isNotEmpty"), [action("skip", "skip_show"), action("show", "skip_show")]),
      rule("r_skip_hide", fieldCond("trig", "isNotEmpty"), [action("skip", "skip_hide"), action("hide", "skip_hide")]),
      rule("r_skip_dis", fieldCond("trig", "isNotEmpty"), [action("skip", "skip_dis"), action("disable", "skip_dis")]),
    ]);

    const res = evaluateConditionalForm({
      fields,
      historicalAnswers: [answer("trig", "go")],
      ruleSet: rules,
    });

    const get = (id: string) => res.fieldStates.find((s) => s.fieldId === id)!;

    expect(get("hid_en")).toEqual({ fieldId: "hid_en", visible: false, effective: false, editable: false, required: false, skipped: false });
    expect(get("hid_req")).toEqual({ fieldId: "hid_req", visible: false, effective: false, editable: false, required: false, skipped: false });
    expect(get("dis_req")).toEqual({ fieldId: "dis_req", visible: true, effective: true, editable: false, required: false, skipped: false });
    expect(res.disabledFieldIds).toContain("dis_req");

    expect(get("show_dis")).toEqual({ fieldId: "show_dis", visible: true, effective: true, editable: false, required: false, skipped: false });
    expect(res.disabledFieldIds).toContain("show_dis");

    expect(get("show_req")).toEqual({ fieldId: "show_req", visible: true, effective: true, editable: true, required: true, skipped: false });

    expect(get("hide_dis")).toEqual({ fieldId: "hide_dis", visible: false, effective: false, editable: false, required: false, skipped: false });
    expect(res.disabledFieldIds).toContain("hide_dis");

    expect(get("skip_show")).toEqual({ fieldId: "skip_show", visible: false, effective: false, editable: false, required: false, skipped: true });
    expect(get("skip_hide")).toEqual({ fieldId: "skip_hide", visible: false, effective: false, editable: false, required: false, skipped: true });
    expect(get("skip_dis")).toEqual({ fieldId: "skip_dis", visible: false, effective: false, editable: false, required: false, skipped: true });
    expect(res.disabledFieldIds).toContain("skip_dis");
  });

  it("table-drives every non-conflicting visibility/enabled/required/skip composition", () => {
    const fields = [
      field("trigger", "shortText"),
      field("target", "shortText", { defaultVisibility: "visible", required: false }),
    ];
    const visibilityIntents = ["none", "show", "hide"] as const;
    const enabledIntents = ["none", "enable", "disable"] as const;
    const requiredIntents = ["off", "on"] as const;
    const skipIntents = ["off", "on"] as const;
    let caseCount = 0;

    for (const visibilityIntent of visibilityIntents) {
      for (const enabledIntent of enabledIntents) {
        for (const requiredIntent of requiredIntents) {
          for (const skipIntent of skipIntents) {
            caseCount += 1;
            const actions: Record<string, unknown>[] = [];
            if (visibilityIntent !== "none") {
              actions.push(action(visibilityIntent, "target"));
            }
            if (enabledIntent !== "none") {
              actions.push(action(enabledIntent, "target"));
            }
            if (requiredIntent === "on") {
              actions.push(action("require", "target"));
            }
            if (skipIntent === "on") {
              actions.push(action("skip", "target"));
            }

            const rules = actions.length === 0
              ? ruleSet([])
              : ruleSet([
                  rule(
                    `r_${visibilityIntent}_${enabledIntent}_${requiredIntent}_${skipIntent}`,
                    fieldCond("trigger", "isNotEmpty"),
                    actions,
                  ),
                ]);
            const result = evaluateConditionalForm({
              fields,
              historicalAnswers: [answer("trigger", "active")],
              ruleSet: rules,
            });
            const targetState = result.fieldStates.find((state) => state.fieldId === "target");
            const skipped = skipIntent === "on";
            const visible = skipped || visibilityIntent === "hide" ? false : true;
            const effective = visible && !skipped;
            const editable = effective && enabledIntent !== "disable";
            const required = effective && editable && requiredIntent === "on";

            expect(targetState).toEqual({
              fieldId: "target",
              visible,
              effective,
              editable,
              required,
              skipped,
            });
            expect(result.hiddenFieldIds).toEqual(visible ? [] : ["target"]);
            expect(result.disabledFieldIds).toEqual(enabledIntent === "disable" ? ["target"] : []);
            expect(result.requiredFieldIds).toEqual(required ? ["target"] : []);
            expect(result.skippedFieldIds).toEqual(skipped ? ["target"] : []);
          }
        }
      }
    }

    expect(caseCount).toBe(3 * 3 * 2 * 2);
  });

  it("handles skip recovery on a separate reevaluation", () => {
    const fields = [
      field("trig", "shortText"),
      field("target", "shortText", { defaultVisibility: "visible", required: true }),
    ];

    const rules = ruleSet([
      rule("r_skip", fieldCond("trig", "equals", "skip"), [action("skip", "target")]),
    ]);

    const history = [answer("trig", "skip"), answer("target", "kept_val")];

    const res1 = evaluateConditionalForm({ fields, historicalAnswers: history, ruleSet: rules });
    const targetState1 = res1.fieldStates.find((s) => s.fieldId === "target")!;
    expect(targetState1.skipped).toBe(true);
    expect(res1.effectiveAnswers.find((a) => a.fieldId === "target")).toBeUndefined();

    const history2 = [answer("trig", "normal"), answer("target", "kept_val")];
    const res2 = evaluateConditionalForm({ fields, historicalAnswers: history2, ruleSet: rules });
    const targetState2 = res2.fieldStates.find((s) => s.fieldId === "target")!;
    expect(targetState2).toEqual({
      fieldId: "target",
      visible: true,
      effective: true,
      editable: true,
      required: true,
      skipped: false,
    });
    expect(res2.effectiveAnswers.find((a) => a.fieldId === "target")?.value).toBe("kept_val");
  });
});

describe("CFP Form Evaluator - Group 3: Order-Independent Action Conflicts & Matching Skip Non-Suppression", () => {
  it("proves show/hide and enable/disable conflicts are order-independent and matching skip does not suppress them", () => {
    const fields = [
      field("trig", "checkbox"),
      field("target", "shortText", { defaultVisibility: "visible" }),
    ];
    const history = [answer("trig", true)];

    const rHide = rule("r_hide", fieldCond("trig", "equals", true), [action("hide", "target")]);
    const rShow = rule("r_show", fieldCond("trig", "equals", true), [action("show", "target")]);
    const rSkip = rule("r_skip", fieldCond("trig", "equals", true), [action("skip", "target")]);

    expectError(
      () => evaluateConditionalForm({ fields, historicalAnswers: history, ruleSet: ruleSet([rHide, rShow]) }),
      "FORM_RULE_ACTION_CONFLICT",
    );
    expectError(
      () => evaluateConditionalForm({ fields, historicalAnswers: history, ruleSet: ruleSet([rShow, rHide]) }),
      "FORM_RULE_ACTION_CONFLICT",
    );
    expectError(
      () => evaluateConditionalForm({ fields, historicalAnswers: history, ruleSet: ruleSet([rShow, rHide, rSkip]) }),
      "FORM_RULE_ACTION_CONFLICT",
    );
    expectError(
      () => evaluateConditionalForm({ fields, historicalAnswers: history, ruleSet: ruleSet([rSkip, rHide, rShow]) }),
      "FORM_RULE_ACTION_CONFLICT",
    );

    const rDisable = rule("r_dis", fieldCond("trig", "equals", true), [action("disable", "target")]);
    const rEnable = rule("r_en", fieldCond("trig", "equals", true), [action("enable", "target")]);

    expectError(
      () => evaluateConditionalForm({ fields, historicalAnswers: history, ruleSet: ruleSet([rDisable, rEnable]) }),
      "FORM_RULE_ACTION_CONFLICT",
    );
    expectError(
      () => evaluateConditionalForm({ fields, historicalAnswers: history, ruleSet: ruleSet([rEnable, rDisable]) }),
      "FORM_RULE_ACTION_CONFLICT",
    );
    expectError(
      () => evaluateConditionalForm({ fields, historicalAnswers: history, ruleSet: ruleSet([rDisable, rEnable, rSkip]) }),
      "FORM_RULE_ACTION_CONFLICT",
    );
    expectError(
      () => evaluateConditionalForm({ fields, historicalAnswers: history, ruleSet: ruleSet([rSkip, rEnable, rDisable]) }),
      "FORM_RULE_ACTION_CONFLICT",
    );
  });
});

describe("CFP Form Evaluator - Group 4: Ineffective History vs Disabled Visible History", () => {
  it("proves default-hidden, rule-hidden, and rule-skipped upstream history cannot drive a later rule or manufacture a conflict, while disabled-visible history can", () => {
    const fields = [
      field("f_def_hid", "shortText", { defaultVisibility: "hidden" }),
      field("f_trig", "shortText", { defaultVisibility: "visible" }),
      field("f_rule_hid", "shortText", { defaultVisibility: "visible" }),
      field("f_rule_skp", "shortText", { defaultVisibility: "visible" }),
      field("f_dis_vis", "shortText", { defaultVisibility: "visible" }),
      field("target_def_hid", "shortText", { defaultVisibility: "hidden" }),
      field("target_rule_hid", "shortText", { defaultVisibility: "hidden" }),
      field("target_rule_skp", "shortText", { defaultVisibility: "hidden" }),
      field("target_dis_vis", "shortText", { defaultVisibility: "hidden" }),
      field("target_conflict", "shortText", { defaultVisibility: "visible" }),
    ];

    const history = [
      answer("f_def_hid", "val_def_hid"),
      answer("f_trig", "go"),
      answer("f_rule_hid", "val_rule_hid"),
      answer("f_rule_skp", "val_rule_skp"),
      answer("f_dis_vis", "val_dis_vis"),
    ];

    const rules = ruleSet([
      rule("r_hide_u", fieldCond("f_trig", "isNotEmpty"), [action("hide", "f_rule_hid")]),
      rule("r_skip_u", fieldCond("f_trig", "isNotEmpty"), [action("skip", "f_rule_skp")]),
      rule("r_dis_u", fieldCond("f_trig", "isNotEmpty"), [action("disable", "f_dis_vis")]),

      rule("r_check_def_hid", fieldCond("f_def_hid", "equals", "val_def_hid"), [action("show", "target_def_hid")]),
      rule("r_check_rule_hid", fieldCond("f_rule_hid", "equals", "val_rule_hid"), [action("show", "target_rule_hid")]),
      rule("r_check_rule_skp", fieldCond("f_rule_skp", "equals", "val_rule_skp"), [action("show", "target_rule_skp")]),
      rule("r_check_dis_vis", fieldCond("f_dis_vis", "equals", "val_dis_vis"), [action("show", "target_dis_vis")]),

      // The show rules are driven only by ineffective history. The opposing hide rule matches.
      rule("r_conf_show_hidden", fieldCond("f_rule_hid", "equals", "val_rule_hid"), [action("show", "target_conflict")]),
      rule("r_conf_show_skipped", fieldCond("f_rule_skp", "equals", "val_rule_skp"), [action("show", "target_conflict")]),
      rule("r_conf_hide", fieldCond("f_trig", "equals", "go"), [action("hide", "target_conflict")]),
    ]);

    const res = evaluateConditionalForm({ fields, historicalAnswers: history, ruleSet: rules });
    expect(res.fieldStates.find((s) => s.fieldId === "target_def_hid")?.visible).toBe(false);
    expect(res.fieldStates.find((s) => s.fieldId === "target_rule_hid")?.visible).toBe(false);
    expect(res.fieldStates.find((s) => s.fieldId === "target_rule_skp")?.visible).toBe(false);
    expect(res.fieldStates.find((s) => s.fieldId === "target_dis_vis")?.visible).toBe(true);
    expect(res.fieldStates.find((s) => s.fieldId === "target_conflict")?.visible).toBe(false);

    expect(res.effectiveAnswers.map((item) => item.fieldId)).toEqual(["f_dis_vis", "f_trig"]);
    for (const ineffectiveId of ["f_def_hid", "f_rule_hid", "f_rule_skp"]) {
      expect(res.effectiveAnswers.map((item) => item.fieldId)).not.toContain(ineffectiveId);
    }
  });
});

describe("CFP Form Evaluator - Group 5: Untouched History & Restoration Cycles with Opaque Values", () => {
  it("proves hide/show and skip/unskip restore byte-identical opaque answers while keeping caller history untouched", () => {
    const fields = [
      field("trig", "shortText"),
      field("opaque_f", "address", { defaultVisibility: "visible" }),
    ];

    const opaqueValue = Object.freeze({
      street: "100 Innovation Way",
      city: "San Francisco",
      metadata: Object.freeze({ verified: true, zip: 94105 }),
    });

    const callerHistory = [answer("trig", "hide"), answer("opaque_f", opaqueValue)];
    const historySnapshot = JSON.stringify(callerHistory);

    // 1. Hide cycle
    const hideRules = ruleSet([rule("r_hide", fieldCond("trig", "equals", "hide"), [action("hide", "opaque_f")])]);
    const resHide = evaluateConditionalForm({ fields, historicalAnswers: callerHistory, ruleSet: hideRules });
    expect(resHide.effectiveAnswers.find((a) => a.fieldId === "opaque_f")).toBeUndefined();
    expect(JSON.stringify(callerHistory)).toBe(historySnapshot);
    expect(callerHistory[1]!.value).toBe(opaqueValue);

    // Restore via show
    const showRules = ruleSet([rule("r_show", fieldCond("trig", "equals", "hide"), [action("show", "opaque_f")])]);
    const resShow = evaluateConditionalForm({ fields, historicalAnswers: callerHistory, ruleSet: showRules });
    const ansShow = resShow.effectiveAnswers.find((a) => a.fieldId === "opaque_f");
    expect(ansShow?.value).toEqual(opaqueValue);

    // 2. Skip cycle
    const skipRules = ruleSet([rule("r_skip", fieldCond("trig", "equals", "hide"), [action("skip", "opaque_f")])]);
    const resSkip = evaluateConditionalForm({ fields, historicalAnswers: callerHistory, ruleSet: skipRules });
    expect(resSkip.effectiveAnswers.find((a) => a.fieldId === "opaque_f")).toBeUndefined();
    expect(JSON.stringify(callerHistory)).toBe(historySnapshot);

    // Restore via unskip (condition false)
    const noMatchRules = ruleSet([rule("r_skip", fieldCond("trig", "equals", "other"), [action("skip", "opaque_f")])]);
    const resUnskip = evaluateConditionalForm({ fields, historicalAnswers: callerHistory, ruleSet: noMatchRules });
    const ansUnskip = resUnskip.effectiveAnswers.find((a) => a.fieldId === "opaque_f");
    expect(ansUnskip?.value).toEqual(opaqueValue);
  });
});

describe("CFP Form Evaluator - Group 6: Complete Matrix of Allowed and Rejected Operator / Value-Class Cells", () => {
  it("verifies every allowed and rejected operator cell through both normalizer and evaluator", () => {
    const fields = [
      field("text_f", "shortText"),
      field("bool_f", "checkbox"),
      field("int_f", "integer"),
      field("dec_f", "decimal"),
      field("arr_f", "multipleChoice"),
      field("date_f", "date"),
      field("struct_f", "section"),
      field("unsupp_f", "address"),
      field("target_f", "shortText", { defaultVisibility: "hidden" }),
    ];

    const ALL_OPS: FormComparisonOperator[] = [...FORM_COMPARISON_OPERATORS];

    const allowedOpsPerClass: Record<string, Set<FormComparisonOperator>> = {
      shortText: new Set(["equals", "notEquals", "in", "notIn", "contains", "notContains", "isEmpty", "isNotEmpty"]),
      date: new Set(["equals", "notEquals", "in", "notIn", "contains", "notContains", "isEmpty", "isNotEmpty"]),
      checkbox: new Set(["equals", "notEquals", "in", "notIn", "isEmpty", "isNotEmpty"]),
      integer: new Set(["equals", "notEquals", "in", "notIn", "lessThan", "lessThanOrEqual", "greaterThan", "greaterThanOrEqual", "isEmpty", "isNotEmpty"]),
      decimal: new Set(["equals", "notEquals", "in", "notIn", "lessThan", "lessThanOrEqual", "greaterThan", "greaterThanOrEqual", "isEmpty", "isNotEmpty"]),
      multipleChoice: new Set(["equals", "notEquals", "contains", "notContains", "isEmpty", "isNotEmpty"]),
      section: new Set(),
      address: new Set(),
    };

    for (const fDef of fields) {
      const fieldId = fDef.id as string;
      if (fieldId === "target_f") continue;
      const fieldType = fDef.type as string;
      const allowedOps = allowedOpsPerClass[fieldType] ?? new Set();

      for (const op of ALL_OPS) {
        let operand: unknown;
        if (op === "isEmpty" || op === "isNotEmpty") {
          operand = undefined;
        } else if (op === "in" || op === "notIn") {
          if (fieldType === "shortText" || fieldType === "date") operand = ["hello"];
          else if (fieldType === "checkbox") operand = [true];
          else if (fieldType === "integer") operand = [42];
          else if (fieldType === "decimal") operand = [3.14];
          else operand = ["opt1"];
        } else if (op === "contains" || op === "notContains") {
          operand = "needle";
        } else if (op === "lessThan" || op === "lessThanOrEqual" || op === "greaterThan" || op === "greaterThanOrEqual") {
          if (fieldType === "integer") operand = 10;
          else if (fieldType === "decimal") operand = 2.5;
          else operand = "2026-08-10";
        } else {
          if (fieldType === "shortText" || fieldType === "date") operand = "hello";
          else if (fieldType === "checkbox") operand = true;
          else if (fieldType === "integer") operand = 42;
          else if (fieldType === "decimal") operand = 3.14;
          else if (fieldType === "multipleChoice") operand = ["opt1"];
          else operand = "val";
        }

        const rSet = ruleSet([rule("r_mat", fieldCond(fieldId, op, operand), [action("show", "target_f")])]);

        if (allowedOps.has(op)) {
          const norm = normalizeFormRuleSet(rSet, fields);
          expect(norm.rules).toHaveLength(1);
          const ev = evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: rSet });
          expect(ev.fieldStates).toBeDefined();
        } else {
          const expectedCode = (fieldType === "section" || fieldType === "address")
            ? "FORM_RULE_CONDITION_INVALID"
            : "FORM_RULE_VALUE_INVALID";
          expectError(() => normalizeFormRuleSet(rSet, fields), expectedCode);
          expectError(() => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: rSet }), expectedCode);
        }
      }
    }
  });

  it("tests typed operand mismatches, array equality order, exact text matching, date-like non-ordering, option non-validation, and unknown operators through both entry points", () => {
    const fields = [
      field("arr_f", "multipleChoice"),
      field("text_f", "shortText"),
      field("choice_f", "singleChoice"),
      field("int_f", "integer", { defaultVisibility: "hidden" }),
      field("date_f", "date"),
    ];

    // Typed operand mismatch: text field with boolean operand in equals through both entry points
    const badTypeRule = ruleSet([rule("r_bad", fieldCond("text_f", "equals", true), [action("show", "int_f")])]);
    expectError(() => normalizeFormRuleSet(badTypeRule, fields), "FORM_RULE_VALUE_INVALID");
    expectError(() => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: badTypeRule }), "FORM_RULE_VALUE_INVALID");

    // Date-like ordering operator rejection through both entry points
    const dateOrderRule = ruleSet([rule("r_date_ord", fieldCond("date_f", "lessThan", "2026-08-10"), [action("show", "int_f")])]);
    expectError(() => normalizeFormRuleSet(dateOrderRule, fields), "FORM_RULE_VALUE_INVALID");
    expectError(() => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: dateOrderRule }), "FORM_RULE_VALUE_INVALID");

    // Array equality order significance (arr_f before int_f) through both entry points
    const arrRule = ruleSet([rule("r_arr", fieldCond("arr_f", "equals", ["a", "b"]), [action("show", "int_f")])]);
    expect(normalizeFormRuleSet(arrRule, fields).rules).toHaveLength(1);

    const resArrMatch = evaluateConditionalForm({
      fields,
      historicalAnswers: [answer("arr_f", ["a", "b"])],
      ruleSet: arrRule,
    });
    expect(resArrMatch.fieldStates.find((s) => s.fieldId === "int_f")?.visible).toBe(true);

    const resArrMismatch = evaluateConditionalForm({
      fields,
      historicalAnswers: [answer("arr_f", ["b", "a"])],
      ruleSet: arrRule,
    });
    expect(resArrMismatch.fieldStates.find((s) => s.fieldId === "int_f")?.visible).toBe(false);

    // Exact / case-sensitive / untrimmed text (text_f before int_f) through both entry points
    const textRule = ruleSet([rule("r_txt", fieldCond("text_f", "equals", "hello"), [action("show", "int_f")])]);
    expect(normalizeFormRuleSet(textRule, fields).rules).toHaveLength(1);

    expect(evaluateConditionalForm({ fields, historicalAnswers: [answer("text_f", "hello")], ruleSet: textRule }).fieldStates.find((s) => s.fieldId === "int_f")?.visible).toBe(true);
    expect(evaluateConditionalForm({ fields, historicalAnswers: [answer("text_f", "hello ")], ruleSet: textRule }).fieldStates.find((s) => s.fieldId === "int_f")?.visible).toBe(false);
    expect(evaluateConditionalForm({ fields, historicalAnswers: [answer("text_f", "Hello")], ruleSet: textRule }).fieldStates.find((s) => s.fieldId === "int_f")?.visible).toBe(false);

    // Unknown operator through both entry points
    const unkOpRule = ruleSet([rule("r_unk", fieldCond("text_f", "regex", ".*"), [action("show", "int_f")])]);
    expectError(() => normalizeFormRuleSet(unkOpRule, fields), "FORM_RULE_OPERATOR_INVALID");
    expectError(() => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: unkOpRule }), "FORM_RULE_OPERATOR_INVALID");

    // Absence of option-registry checking: arbitrary singleChoice string is ALLOWED through both entry points
    const optionRule = ruleSet([rule("r_opt", fieldCond("choice_f", "equals", "custom_unregistered_choice"), [action("show", "int_f")])]);
    expect(normalizeFormRuleSet(optionRule, fields).rules).toHaveLength(1);
    const resOpt = evaluateConditionalForm({
      fields,
      historicalAnswers: [answer("choice_f", "custom_unregistered_choice")],
      ruleSet: optionRule,
    });
    expect(resOpt.fieldStates.find((s) => s.fieldId === "int_f")?.visible).toBe(true);
  });
});

describe("CFP Form Evaluator - Group 7: Missing and Empty Values Semantics Across All Operators", () => {
  it("table-drives missing, null, empty string, and empty array across every operator family: only isEmpty matches", () => {
    const fields = [
      field("f_txt", "shortText"),
      field("f_int", "integer"),
      field("f_arr", "multipleChoice"),
      field("target", "shortText", { defaultVisibility: "hidden" }),
    ];

    // Table of empty/missing test cases for text
    const emptyStates: Array<{ name: string; ans?: unknown }> = [
      { name: "missing", ans: undefined },
      { name: "null", ans: null },
      { name: "empty text", ans: "" },
    ];

    for (const state of emptyStates) {
      const history = state.ans !== undefined ? [answer("f_txt", state.ans)] : [];

      // isEmpty -> MUST be true
      const rIsEmpty = ruleSet([rule("r", fieldCond("f_txt", "isEmpty"), [action("show", "target")])]);
      expect(evaluateConditionalForm({ fields, historicalAnswers: history, ruleSet: rIsEmpty }).fieldStates.find((s) => s.fieldId === "target")?.visible).toBe(true);

      // isNotEmpty -> MUST be false
      const rIsNotEmpty = ruleSet([rule("r", fieldCond("f_txt", "isNotEmpty"), [action("show", "target")])]);
      expect(evaluateConditionalForm({ fields, historicalAnswers: history, ruleSet: rIsNotEmpty }).fieldStates.find((s) => s.fieldId === "target")?.visible).toBe(false);

      // positive & negative equality -> MUST be false
      const rEq = ruleSet([rule("r", fieldCond("f_txt", "equals", "val"), [action("show", "target")])]);
      expect(evaluateConditionalForm({ fields, historicalAnswers: history, ruleSet: rEq }).fieldStates.find((s) => s.fieldId === "target")?.visible).toBe(false);

      const rNeq = ruleSet([rule("r", fieldCond("f_txt", "notEquals", "val"), [action("show", "target")])]);
      expect(evaluateConditionalForm({ fields, historicalAnswers: history, ruleSet: rNeq }).fieldStates.find((s) => s.fieldId === "target")?.visible).toBe(false);

      // positive & negative membership -> MUST be false
      const rIn = ruleSet([rule("r", fieldCond("f_txt", "in", ["val"]), [action("show", "target")])]);
      expect(evaluateConditionalForm({ fields, historicalAnswers: history, ruleSet: rIn }).fieldStates.find((s) => s.fieldId === "target")?.visible).toBe(false);

      const rNin = ruleSet([rule("r", fieldCond("f_txt", "notIn", ["val"]), [action("show", "target")])]);
      expect(evaluateConditionalForm({ fields, historicalAnswers: history, ruleSet: rNin }).fieldStates.find((s) => s.fieldId === "target")?.visible).toBe(false);

      // positive & negative containment -> MUST be false
      const rContains = ruleSet([rule("r", fieldCond("f_txt", "contains", "val"), [action("show", "target")])]);
      expect(evaluateConditionalForm({ fields, historicalAnswers: history, ruleSet: rContains }).fieldStates.find((s) => s.fieldId === "target")?.visible).toBe(false);

      const rNcontains = ruleSet([rule("r", fieldCond("f_txt", "notContains", "val"), [action("show", "target")])]);
      expect(evaluateConditionalForm({ fields, historicalAnswers: history, ruleSet: rNcontains }).fieldStates.find((s) => s.fieldId === "target")?.visible).toBe(false);
    }

    // Empty string array []
    const emptyArrHistory = [answer("f_arr", [])];
    const rArrIsEmpty = ruleSet([rule("r", fieldCond("f_arr", "isEmpty"), [action("show", "target")])]);
    expect(evaluateConditionalForm({ fields, historicalAnswers: emptyArrHistory, ruleSet: rArrIsEmpty }).fieldStates.find((s) => s.fieldId === "target")?.visible).toBe(true);

    const rArrIsNotEmpty = ruleSet([rule("r", fieldCond("f_arr", "isNotEmpty"), [action("show", "target")])]);
    expect(evaluateConditionalForm({ fields, historicalAnswers: emptyArrHistory, ruleSet: rArrIsNotEmpty }).fieldStates.find((s) => s.fieldId === "target")?.visible).toBe(false);

    const rArrEq = ruleSet([rule("r", fieldCond("f_arr", "equals", ["val"]), [action("show", "target")])]);
    expect(evaluateConditionalForm({ fields, historicalAnswers: emptyArrHistory, ruleSet: rArrEq }).fieldStates.find((s) => s.fieldId === "target")?.visible).toBe(false);

    const rArrNeq = ruleSet([rule("r", fieldCond("f_arr", "notEquals", ["val"]), [action("show", "target")])]);
    expect(evaluateConditionalForm({ fields, historicalAnswers: emptyArrHistory, ruleSet: rArrNeq }).fieldStates.find((s) => s.fieldId === "target")?.visible).toBe(false);

    const rArrContains = ruleSet([rule("r", fieldCond("f_arr", "contains", "val"), [action("show", "target")])]);
    expect(evaluateConditionalForm({ fields, historicalAnswers: emptyArrHistory, ruleSet: rArrContains }).fieldStates.find((s) => s.fieldId === "target")?.visible).toBe(false);

    const rArrNcontains = ruleSet([rule("r", fieldCond("f_arr", "notContains", "val"), [action("show", "target")])]);
    expect(evaluateConditionalForm({ fields, historicalAnswers: emptyArrHistory, ruleSet: rArrNcontains }).fieldStates.find((s) => s.fieldId === "target")?.visible).toBe(false);

    // Missing and null numeric ordering
    for (const numAns of [undefined, null]) {
      const numHistory = numAns !== undefined ? [answer("f_int", numAns)] : [];
      for (const op of ["lessThan", "lessThanOrEqual", "greaterThan", "greaterThanOrEqual"] as const) {
        const rOrder = ruleSet([rule("r", fieldCond("f_int", op, 10), [action("show", "target")])]);
        expect(evaluateConditionalForm({ fields, historicalAnswers: numHistory, ruleSet: rOrder }).fieldStates.find((s) => s.fieldId === "target")?.visible).toBe(false);
      }
    }
  });

  it("keeps direct negative operators false for missing and empty values while logical not over the same leaf is true", () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly fields: Record<string, unknown>[];
      readonly history: Record<string, unknown>[];
      readonly leaf: Record<string, unknown>;
    }> = [
      {
        name: "missing",
        fields: [field("value"), field("target", "shortText", { defaultVisibility: "hidden" })],
        history: [],
        leaf: fieldCond("value", "notEquals", "needle"),
      },
      {
        name: "null",
        fields: [field("value"), field("target", "shortText", { defaultVisibility: "hidden" })],
        history: [answer("value", null)],
        leaf: fieldCond("value", "notEquals", "needle"),
      },
      {
        name: "empty string",
        fields: [field("value"), field("target", "shortText", { defaultVisibility: "hidden" })],
        history: [answer("value", "")],
        leaf: fieldCond("value", "notEquals", "needle"),
      },
      {
        name: "empty array",
        fields: [field("value", "multipleChoice"), field("target", "shortText", { defaultVisibility: "hidden" })],
        history: [answer("value", [])],
        leaf: fieldCond("value", "notContains", "needle"),
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const directResult = evaluateConditionalForm({
        fields: testCase.fields,
        historicalAnswers: testCase.history,
        ruleSet: ruleSet([rule(`r_direct_${index}`, testCase.leaf, [action("show", "target")])]),
      });
      expect(directResult.fieldStates.find((state) => state.fieldId === "target")?.visible, testCase.name).toBe(false);

      const logicalNotResult = evaluateConditionalForm({
        fields: testCase.fields,
        historicalAnswers: testCase.history,
        ruleSet: ruleSet([
          rule(
            `r_not_${index}`,
            { kind: "not", condition: testCase.leaf },
            [action("show", "target")],
          ),
        ]),
      });
      expect(logicalNotResult.fieldStates.find((state) => state.fieldId === "target")?.visible, testCase.name).toBe(true);
    }
  });

  it("table-drives every valid operator family for whitespace, false, integer zero, and decimal zero sentinels", () => {
    const fields = [
      field("f_txt", "shortText"),
      field("f_bool", "checkbox"),
      field("f_int", "integer"),
      field("f_dec", "decimal"),
      field("target", "shortText", { defaultVisibility: "hidden" }),
    ];

    const cases: ReadonlyArray<{
      readonly fieldId: string;
      readonly historyValue: unknown;
      readonly operator: FormComparisonOperator;
      readonly operand?: unknown;
      readonly matches: boolean;
    }> = [
      { fieldId: "f_txt", historyValue: "   ", operator: "isEmpty", matches: false },
      { fieldId: "f_txt", historyValue: "   ", operator: "isNotEmpty", matches: true },
      { fieldId: "f_txt", historyValue: "   ", operator: "equals", operand: "   ", matches: true },
      { fieldId: "f_txt", historyValue: "   ", operator: "equals", operand: "other", matches: false },
      { fieldId: "f_txt", historyValue: "   ", operator: "notEquals", operand: "other", matches: true },
      { fieldId: "f_txt", historyValue: "   ", operator: "notEquals", operand: "   ", matches: false },
      { fieldId: "f_txt", historyValue: "   ", operator: "in", operand: ["   "], matches: true },
      { fieldId: "f_txt", historyValue: "   ", operator: "in", operand: ["other"], matches: false },
      { fieldId: "f_txt", historyValue: "   ", operator: "notIn", operand: ["other"], matches: true },
      { fieldId: "f_txt", historyValue: "   ", operator: "notIn", operand: ["   "], matches: false },
      { fieldId: "f_txt", historyValue: "   ", operator: "contains", operand: " ", matches: true },
      { fieldId: "f_txt", historyValue: "   ", operator: "contains", operand: "x", matches: false },
      { fieldId: "f_txt", historyValue: "   ", operator: "notContains", operand: "x", matches: true },
      { fieldId: "f_txt", historyValue: "   ", operator: "notContains", operand: " ", matches: false },

      { fieldId: "f_bool", historyValue: false, operator: "isEmpty", matches: false },
      { fieldId: "f_bool", historyValue: false, operator: "isNotEmpty", matches: true },
      { fieldId: "f_bool", historyValue: false, operator: "equals", operand: false, matches: true },
      { fieldId: "f_bool", historyValue: false, operator: "equals", operand: true, matches: false },
      { fieldId: "f_bool", historyValue: false, operator: "notEquals", operand: true, matches: true },
      { fieldId: "f_bool", historyValue: false, operator: "notEquals", operand: false, matches: false },
      { fieldId: "f_bool", historyValue: false, operator: "in", operand: [false], matches: true },
      { fieldId: "f_bool", historyValue: false, operator: "in", operand: [true], matches: false },
      { fieldId: "f_bool", historyValue: false, operator: "notIn", operand: [true], matches: true },
      { fieldId: "f_bool", historyValue: false, operator: "notIn", operand: [false], matches: false },

      { fieldId: "f_int", historyValue: 0, operator: "isEmpty", matches: false },
      { fieldId: "f_int", historyValue: 0, operator: "isNotEmpty", matches: true },
      { fieldId: "f_int", historyValue: 0, operator: "equals", operand: 0, matches: true },
      { fieldId: "f_int", historyValue: 0, operator: "equals", operand: 1, matches: false },
      { fieldId: "f_int", historyValue: 0, operator: "notEquals", operand: 1, matches: true },
      { fieldId: "f_int", historyValue: 0, operator: "notEquals", operand: 0, matches: false },
      { fieldId: "f_int", historyValue: 0, operator: "in", operand: [0], matches: true },
      { fieldId: "f_int", historyValue: 0, operator: "in", operand: [1], matches: false },
      { fieldId: "f_int", historyValue: 0, operator: "notIn", operand: [1], matches: true },
      { fieldId: "f_int", historyValue: 0, operator: "notIn", operand: [0], matches: false },
      { fieldId: "f_int", historyValue: 0, operator: "lessThan", operand: 1, matches: true },
      { fieldId: "f_int", historyValue: 0, operator: "lessThan", operand: -1, matches: false },
      { fieldId: "f_int", historyValue: 0, operator: "lessThanOrEqual", operand: 0, matches: true },
      { fieldId: "f_int", historyValue: 0, operator: "lessThanOrEqual", operand: -1, matches: false },
      { fieldId: "f_int", historyValue: 0, operator: "greaterThan", operand: -1, matches: true },
      { fieldId: "f_int", historyValue: 0, operator: "greaterThan", operand: 1, matches: false },
      { fieldId: "f_int", historyValue: 0, operator: "greaterThanOrEqual", operand: 0, matches: true },
      { fieldId: "f_int", historyValue: 0, operator: "greaterThanOrEqual", operand: 1, matches: false },

      { fieldId: "f_dec", historyValue: -0, operator: "isEmpty", matches: false },
      { fieldId: "f_dec", historyValue: -0, operator: "isNotEmpty", matches: true },
      { fieldId: "f_dec", historyValue: -0, operator: "equals", operand: -0, matches: true },
      { fieldId: "f_dec", historyValue: -0, operator: "equals", operand: 1, matches: false },
      { fieldId: "f_dec", historyValue: -0, operator: "notEquals", operand: 1, matches: true },
      { fieldId: "f_dec", historyValue: -0, operator: "notEquals", operand: -0, matches: false },
      { fieldId: "f_dec", historyValue: -0, operator: "in", operand: [-0], matches: true },
      { fieldId: "f_dec", historyValue: -0, operator: "in", operand: [1], matches: false },
      { fieldId: "f_dec", historyValue: -0, operator: "notIn", operand: [1], matches: true },
      { fieldId: "f_dec", historyValue: -0, operator: "notIn", operand: [-0], matches: false },
      { fieldId: "f_dec", historyValue: -0, operator: "lessThan", operand: 1, matches: true },
      { fieldId: "f_dec", historyValue: -0, operator: "lessThan", operand: -1, matches: false },
      { fieldId: "f_dec", historyValue: -0, operator: "lessThanOrEqual", operand: -0, matches: true },
      { fieldId: "f_dec", historyValue: -0, operator: "lessThanOrEqual", operand: -1, matches: false },
      { fieldId: "f_dec", historyValue: -0, operator: "greaterThan", operand: -1, matches: true },
      { fieldId: "f_dec", historyValue: -0, operator: "greaterThan", operand: 1, matches: false },
      { fieldId: "f_dec", historyValue: -0, operator: "greaterThanOrEqual", operand: -0, matches: true },
      { fieldId: "f_dec", historyValue: -0, operator: "greaterThanOrEqual", operand: 1, matches: false },
    ];

    for (const [index, testCase] of cases.entries()) {
      const candidateRuleSet = ruleSet([
        rule(
          `r_sentinel_${index}`,
          fieldCond(testCase.fieldId, testCase.operator, testCase.operand),
          [action("show", "target")],
        ),
      ]);
      const normalized = normalizeFormRuleSet(candidateRuleSet, fields);
      expect(normalized.rules).toHaveLength(1);
      if (Object.is(testCase.operand, -0)) {
        const condition = normalized.rules[0]!.condition;
        expect(condition.kind).toBe("field");
        if (condition.kind === "field") {
          expect(condition.value).toBe(0);
        }
      }

      const result = evaluateConditionalForm({
        fields,
        historicalAnswers: [answer(testCase.fieldId, testCase.historyValue)],
        ruleSet: candidateRuleSet,
      });
      expect(result.fieldStates.find((state) => state.fieldId === "target")?.visible).toBe(testCase.matches);
    }

    const decimalResult = evaluateConditionalForm({
      fields,
      historicalAnswers: [answer("f_dec", -0)],
      ruleSet: ruleSet([]),
    });
    expect(Object.is(decimalResult.effectiveAnswers.find((item) => item.fieldId === "f_dec")?.value, 0)).toBe(true);

    // Empty needle and empty membership lists remain normalization errors through both entry points.
    const emptyNeedleRule = ruleSet([rule("r_empty_needle", fieldCond("f_txt", "contains", ""), [action("show", "target")])]);
    expectError(() => normalizeFormRuleSet(emptyNeedleRule, fields), "FORM_RULE_VALUE_INVALID");
    expectError(() => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: emptyNeedleRule }), "FORM_RULE_VALUE_INVALID");

    const emptyInRule = ruleSet([rule("r_empty_in", fieldCond("f_txt", "in", []), [action("show", "target")])]);
    expectError(() => normalizeFormRuleSet(emptyInRule, fields), "FORM_RULE_VALUE_INVALID");
    expectError(() => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: emptyInRule }), "FORM_RULE_VALUE_INVALID");
  });
});

describe("CFP Form Evaluator - Group 8: Topology, Dependency & Structural Error Validation", () => {
  it("restores exact topology errors: noncyclic forward, self, genuine cycle, unknown ref, unknown/container action target, duplicate fields/rules/answers, unknown/container historical answers, and invalid field type", () => {
    const f1 = field("f1");
    const f2 = field("f2");
    const f3 = field("f3");
    const sec = field("sec", "section");

    // 1. Noncyclic forward reference -> FORM_FIELD_REFERENCE_FORWARD
    const fwdRule = ruleSet([rule("r_fwd", fieldCond("f2", "isNotEmpty"), [action("show", "f1")])]);
    expectError(() => evaluateConditionalForm({ fields: [f1, f2], historicalAnswers: [], ruleSet: fwdRule }), "FORM_FIELD_REFERENCE_FORWARD");

    // 2. Self reference -> FORM_FIELD_REFERENCE_SELF
    const selfRule = ruleSet([rule("r_self", fieldCond("f1", "isNotEmpty"), [action("show", "f1")])]);
    expectError(() => evaluateConditionalForm({ fields: [f1], historicalAnswers: [], ruleSet: selfRule }), "FORM_FIELD_REFERENCE_SELF");

    // 3. Genuine multi-field cycle -> FORM_FIELD_DEPENDENCY_CYCLE
    const cycleRules = ruleSet([
      rule("r1", fieldCond("f1", "isNotEmpty"), [action("show", "f2")]),
      rule("r2", fieldCond("f2", "isNotEmpty"), [action("show", "f1")]),
    ]);
    expectError(() => evaluateConditionalForm({ fields: [f1, f2], historicalAnswers: [], ruleSet: cycleRules }), "FORM_FIELD_DEPENDENCY_CYCLE");

    // 4. Unknown condition reference -> FORM_FIELD_REFERENCE_UNKNOWN
    const unkRefRule = ruleSet([rule("r_unk_ref", fieldCond("unknown_f", "isNotEmpty"), [action("show", "f2")])]);
    expectError(() => evaluateConditionalForm({ fields: [f1, f2], historicalAnswers: [], ruleSet: unkRefRule }), "FORM_FIELD_REFERENCE_UNKNOWN");

    // 5. Unknown action target -> FORM_RULE_TARGET_UNKNOWN
    const unkTgtRule = ruleSet([rule("r_unk_tgt", fieldCond("f1", "isNotEmpty"), [action("show", "unknown_f")])]);
    expectError(() => evaluateConditionalForm({ fields: [f1, f2], historicalAnswers: [], ruleSet: unkTgtRule }), "FORM_RULE_TARGET_UNKNOWN");

    // 6. Container action target -> FORM_RULE_TARGET_UNKNOWN
    const containerTgtRule = ruleSet([rule("r_ctr_tgt", fieldCond("f1", "isNotEmpty"), [action("show", "sec")])]);
    expectError(() => evaluateConditionalForm({ fields: [f1, f2, sec], historicalAnswers: [], ruleSet: containerTgtRule }), "FORM_RULE_TARGET_UNKNOWN");

    // 7. Duplicate fields -> FORM_FIELD_DUPLICATE
    expectError(() => evaluateConditionalForm({ fields: [f1, field("f1")], historicalAnswers: [], ruleSet: ruleSet([]) }), "FORM_FIELD_DUPLICATE");

    // 8. Duplicate rules -> FORM_RULE_DUPLICATE
    const dupRules = ruleSet([
      rule("r1", fieldCond("f1", "isNotEmpty"), [action("show", "f2")]),
      rule("r1", fieldCond("f1", "isNotEmpty"), [action("hide", "f2")]),
    ]);
    expectError(() => evaluateConditionalForm({ fields: [f1, f2], historicalAnswers: [], ruleSet: dupRules }), "FORM_RULE_DUPLICATE");

    // 9. Duplicate answers -> FORM_HISTORICAL_ANSWER_DUPLICATE
    expectError(
      () => evaluateConditionalForm({ fields: [f1], historicalAnswers: [answer("f1", "v1"), answer("f1", "v2")], ruleSet: ruleSet([]) }),
      "FORM_HISTORICAL_ANSWER_DUPLICATE",
    );

    // 10. Unknown historical answer -> FORM_HISTORICAL_ANSWER_FIELD_UNKNOWN
    expectError(
      () => evaluateConditionalForm({ fields: [f1], historicalAnswers: [answer("unknown_f", "v1")], ruleSet: ruleSet([]) }),
      "FORM_HISTORICAL_ANSWER_FIELD_UNKNOWN",
    );

    // 11. Container historical answer -> FORM_HISTORICAL_ANSWER_FIELD_CONTAINER
    expectError(
      () => evaluateConditionalForm({ fields: [f1, sec], historicalAnswers: [answer("sec", "v1")], ruleSet: ruleSet([]) }),
      "FORM_HISTORICAL_ANSWER_FIELD_CONTAINER",
    );

    // 12. Invalid field type -> FORM_FIELD_TYPE_INVALID
    expectError(
      () => evaluateConditionalForm({ fields: [field("bad", "invalid_type")], historicalAnswers: [], ruleSet: ruleSet([]) }),
      "FORM_FIELD_TYPE_INVALID",
    );
  });

  it("pre-validates wrong-shaped history for all value classes before condition evaluation", () => {
    const fields = [
      field("f_txt", "shortText"),
      field("f_bool", "checkbox"),
      field("f_int", "integer"),
      field("f_dec", "decimal"),
      field("f_arr", "multipleChoice"),
      field("unref", "integer"),
    ];

    const posRule = ruleSet([rule("r1", fieldCond("f_txt", "equals", "val"), [action("show", "unref")])]);
    const negRule = ruleSet([rule("r2", fieldCond("f_txt", "notEquals", "other"), [action("show", "unref")])]);
    const emptyRuleSet = ruleSet([]);

    const invalidHistories = [
      answer("f_txt", 123),
      answer("f_bool", "true"),
      answer("f_int", 1.5),
      answer("f_dec", "3.14"),
      answer("f_arr", "opt1"),
      answer("unref", "not_a_number"),
    ];

    for (const badAns of invalidHistories) {
      expectError(
        () => evaluateConditionalForm({ fields, historicalAnswers: [badAns], ruleSet: posRule }),
        "FORM_HISTORICAL_ANSWER_VALUE_INVALID",
      );
      expectError(
        () => evaluateConditionalForm({ fields, historicalAnswers: [badAns], ruleSet: negRule }),
        "FORM_HISTORICAL_ANSWER_VALUE_INVALID",
      );
      expectError(
        () => evaluateConditionalForm({ fields, historicalAnswers: [badAns], ruleSet: emptyRuleSet }),
        "FORM_HISTORICAL_ANSWER_VALUE_INVALID",
      );
    }
  });
});

describe("CFP Form Evaluator - Group 9: Structural Limits & Exact Boundary Fixtures", () => {
  it("proves 257-answer fixture with 256 fields fails answer-count precheck with FORM_RULE_LIMIT_EXCEEDED without over-limit fields", () => {
    const exactFields = Array.from({ length: 256 }, (_, i) => field(`f_${i}`));
    expect(exactFields).toHaveLength(256);

    const exactFieldRuleSet = ruleSet([]);
    expect(normalizeFormRuleSet(exactFieldRuleSet, exactFields).rules).toHaveLength(0);
    expect(
      evaluateConditionalForm({ fields: exactFields, historicalAnswers: [], ruleSet: exactFieldRuleSet }).fieldStates,
    ).toHaveLength(256);

    const overFields = [...exactFields, field("f_256")];
    expect(overFields).toHaveLength(257);
    expectError(() => normalizeFormRuleSet(exactFieldRuleSet, overFields), "FORM_RULE_LIMIT_EXCEEDED");
    expectError(
      () => evaluateConditionalForm({ fields: overFields, historicalAnswers: [], ruleSet: exactFieldRuleSet }),
      "FORM_RULE_LIMIT_EXCEEDED",
    );

    const exactAnswers = exactFields.map((candidate) => answer(candidate.id as string, "value"));
    expect(exactAnswers).toHaveLength(256);
    const exactAnswerResult = evaluateConditionalForm({
      fields: exactFields,
      historicalAnswers: exactAnswers,
      ruleSet: exactFieldRuleSet,
    });
    expect(exactAnswerResult.effectiveAnswers).toHaveLength(256);

    const overAnswers = Array.from({ length: 257 }, (_, i) => answer(`f_${i % 256}`, "val"));
    expect(overAnswers).toHaveLength(257);

    expectError(
      () => evaluateConditionalForm({ fields: exactFields, historicalAnswers: overAnswers, ruleSet: ruleSet([]) }),
      "FORM_RULE_LIMIT_EXCEEDED",
    );
  });

  it("proves exact and over rule-count boundaries through both public entry points", () => {
    const fields = [field("f0"), field("f1")];
    const exactRules = Array.from({ length: 256 }, (_, i) =>
      rule(`r_${i}`, fieldCond("f0", "isEmpty"), [action("show", "f1")]),
    );
    expect(exactRules).toHaveLength(256);
    const exactRuleSet = ruleSet(exactRules);

    expect(normalizeFormRuleSet(exactRuleSet, fields).rules).toHaveLength(256);
    expect(
      evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: exactRuleSet }).fieldStates,
    ).toHaveLength(2);

    const overRules = [...exactRules, rule("r_256", fieldCond("f0", "isEmpty"), [action("show", "f1")])];
    expect(overRules).toHaveLength(257);
    const overRuleSet = ruleSet(overRules);
    expectError(() => normalizeFormRuleSet(overRuleSet, fields), "FORM_RULE_LIMIT_EXCEEDED");
    expectError(
      () => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: overRuleSet }),
      "FORM_RULE_LIMIT_EXCEEDED",
    );
  });

  it("pins condition depth 16/17 and condition node 512/513 boundaries without earlier safety failures", () => {
    const fields = [field("f0"), field("f1")];

    const nestedNot = (depth: number): Record<string, unknown> => {
      let condition: Record<string, unknown> = fieldCond("f0", "isEmpty");
      for (let index = 0; index < depth; index += 1) {
        condition = { kind: "not", condition };
      }
      return condition;
    };

    const depth16 = ruleSet([rule("r_depth_16", nestedNot(16), [action("show", "f1")])]);
    const depth17 = ruleSet([rule("r_depth_17", nestedNot(17), [action("show", "f1")])]);
    expect(normalizeFormRuleSet(depth16, fields).rules).toHaveLength(1);
    expect(evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: depth16 }).fieldStates).toHaveLength(2);
    expectError(() => normalizeFormRuleSet(depth17, fields), "FORM_RULE_CONDITION_LIMIT_EXCEEDED");
    expectError(
      () => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: depth17 }),
      "FORM_RULE_CONDITION_LIMIT_EXCEEDED",
    );

    const conditionGroups = (extraLeaf: boolean): Record<string, unknown> => {
      const groups = Array.from({ length: 8 }, (_, groupIndex) => {
        const leafCount = groupIndex === 7 ? (extraLeaf ? 63 : 62) : 63;
        return {
          kind: "all",
          conditions: Array.from({ length: leafCount }, () => fieldCond("f0", "isEmpty")),
        };
      });
      return { kind: "all", conditions: groups };
    };

    const countConditionNodes = (condition: unknown): number => {
      if (condition === null || typeof condition !== "object" || Array.isArray(condition)) return 0;
      const candidate = condition as Record<string, unknown>;
      if (candidate.kind === "field") return 1;
      if (candidate.kind === "not") return 1 + countConditionNodes(candidate.condition);
      if (candidate.kind === "all" || candidate.kind === "any") {
        return 1 + (candidate.conditions as unknown[]).reduce<number>(
          (count, child) => count + countConditionNodes(child),
          0,
        );
      }
      return 0;
    };
    const condition512 = conditionGroups(false);
    const condition513 = conditionGroups(true);
    const maxGroupChildren = (condition: Record<string, unknown>): number =>
      Math.max(
        ...(condition.conditions as Array<Record<string, unknown>>).map(
          (group) => (group.conditions as unknown[]).length,
        ),
      );
    expect(countConditionNodes(condition512)).toBe(512);
    expect(countConditionNodes(condition513)).toBe(513);
    expect(maxGroupChildren(condition512)).toBeLessThanOrEqual(64);
    expect(maxGroupChildren(condition513)).toBeLessThanOrEqual(64);

    const nodes512 = ruleSet([rule("r_nodes_512", condition512, [action("show", "f1")])]);
    const nodes513 = ruleSet([rule("r_nodes_513", condition513, [action("show", "f1")])]);
    expect(normalizeFormRuleSet(nodes512, fields).rules).toHaveLength(1);
    expect(evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: nodes512 }).fieldStates).toHaveLength(2);
    expectError(() => normalizeFormRuleSet(nodes513, fields), "FORM_RULE_CONDITION_LIMIT_EXCEEDED");
    expectError(
      () => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: nodes513 }),
      "FORM_RULE_CONDITION_LIMIT_EXCEEDED",
    );
  });

  it("pins condition child-array 64/65 boundaries while all other rule limits remain valid", () => {
    const fields = [field("f0"), field("f1")];
    const makeCondition = (count: number): Record<string, unknown> => ({
      kind: "all",
      conditions: Array.from({ length: count }, () => fieldCond("f0", "isEmpty")),
    });
    for (const kind of ["all", "any"] as const) {
      const emptyGroup = ruleSet([rule(`r_empty_${kind}`, { kind, conditions: [] }, [action("show", "f1")])]);
      expectError(() => normalizeFormRuleSet(emptyGroup, fields), "FORM_RULE_CONDITION_INVALID");
      expectError(
        () => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: emptyGroup }),
        "FORM_RULE_CONDITION_INVALID",
      );
    }
    const children64 = ruleSet([rule("r_children_64", makeCondition(64), [action("show", "f1")])]);
    const children65 = ruleSet([rule("r_children_65", makeCondition(65), [action("show", "f1")])]);

    expect(normalizeFormRuleSet(children64, fields).rules).toHaveLength(1);
    expect(evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: children64 }).fieldStates).toHaveLength(2);
    expectError(() => normalizeFormRuleSet(children65, fields), "FORM_RULE_CONDITION_LIMIT_EXCEEDED");
    expectError(
      () => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: children65 }),
      "FORM_RULE_CONDITION_LIMIT_EXCEEDED",
    );
  });

  it("tests exact/over boundaries for actions per rule (64/65) and membership candidates (64/65) through both entry points", () => {
    const baseFields = [field("f0"), field("f1")];

    // Actions per rule (64 pass, 65 fail)
    const exactActions = Array.from({ length: 64 }, () => action("show", "f1"));
    const overActions = Array.from({ length: 65 }, () => action("show", "f1"));

    const exactActionRule = ruleSet([rule("r_act", fieldCond("f0", "isNotEmpty"), exactActions)]);
    const overActionRule = ruleSet([rule("r_act", fieldCond("f0", "isNotEmpty"), overActions)]);

    expect(normalizeFormRuleSet(exactActionRule, baseFields).rules).toHaveLength(1);
    expect(evaluateConditionalForm({ fields: baseFields, historicalAnswers: [], ruleSet: exactActionRule }).fieldStates).toHaveLength(2);

    expectError(() => normalizeFormRuleSet(overActionRule, baseFields), "FORM_RULE_LIMIT_EXCEEDED");
    expectError(() => evaluateConditionalForm({ fields: baseFields, historicalAnswers: [], ruleSet: overActionRule }), "FORM_RULE_LIMIT_EXCEEDED");

    // Membership candidates (64 pass, 65 fail)
    const exactCandidates = Array.from({ length: 64 }, (_, i) => `cand_${i}`);
    const overCandidates = Array.from({ length: 65 }, (_, i) => `cand_${i}`);

    const exactInRule = ruleSet([rule("r_in", fieldCond("f0", "in", exactCandidates), [action("show", "f1")])]);
    const overInRule = ruleSet([rule("r_in", fieldCond("f0", "in", overCandidates), [action("show", "f1")])]);

    expect(normalizeFormRuleSet(exactInRule, baseFields).rules).toHaveLength(1);
    expect(evaluateConditionalForm({ fields: baseFields, historicalAnswers: [], ruleSet: exactInRule }).fieldStates).toHaveLength(2);

    expectError(() => normalizeFormRuleSet(overInRule, baseFields), "FORM_RULE_VALUE_INVALID");
    expectError(() => evaluateConditionalForm({ fields: baseFields, historicalAnswers: [], ruleSet: overInRule }), "FORM_RULE_VALUE_INVALID");
  });

  it("tests multibyte needle fixtures with exact UTF-8 byte lengths 256 and 257 through both entry points", () => {
    const baseFields = [field("f0"), field("f1")];

    const passNeedle = "é".repeat(128);
    const failNeedle = `${"é".repeat(128)}a`;

    expect(Buffer.byteLength(passNeedle, "utf8")).toBe(256);
    expect(Buffer.byteLength(failNeedle, "utf8")).toBe(257);
    expect(passNeedle.length).toBe(128);
    expect(failNeedle.length).toBe(129);

    const passNeedleRule = ruleSet([rule("r_ndl", fieldCond("f0", "contains", passNeedle), [action("show", "f1")])]);
    const failNeedleRule = ruleSet([rule("r_ndl", fieldCond("f0", "contains", failNeedle), [action("show", "f1")])]);

    expect(normalizeFormRuleSet(passNeedleRule, baseFields).rules).toHaveLength(1);
    expect(evaluateConditionalForm({ fields: baseFields, historicalAnswers: [], ruleSet: passNeedleRule }).fieldStates).toHaveLength(2);

    expectError(() => normalizeFormRuleSet(failNeedleRule, baseFields), "FORM_RULE_VALUE_INVALID");
    expectError(() => evaluateConditionalForm({ fields: baseFields, historicalAnswers: [], ruleSet: failNeedleRule }), "FORM_RULE_VALUE_INVALID");
  });

  it("constructs semantically valid rule sets with serialized UTF-8 bytes exact 262,144 (pass) and 262,145 (fail) using distinct <=64KiB strings through both entry points", () => {
    const baseFields = [field("f0"), field("f1")];

    // Build distinct candidate strings each <= 64 KiB (65,536 bytes)
    const c1 = "x".repeat(50000);
    const c2 = "y".repeat(50000);
    const c3 = "z".repeat(50000);
    const c4 = "w".repeat(50000);

    const dummyRuleSet = {
      schema: FORM_RULES_SCHEMA,
      ruleVersionId: "v1",
      rules: [
        {
          id: "r0",
          condition: {
            kind: "field",
            fieldId: "f0",
            operator: "in",
            value: ["", c1, c2, c3, c4],
          },
          actions: [{ type: "show", targetFieldId: "f1" }],
        },
      ],
    };

    const dummyBytes = Buffer.byteLength(JSON.stringify(dummyRuleSet), "utf8");
    const c0Length = 262144 - dummyBytes;
    expect(c0Length).toBeLessThanOrEqual(65536);

    const c0Exact = "a".repeat(c0Length);
    const exactRuleSet = {
      schema: FORM_RULES_SCHEMA,
      ruleVersionId: "v1",
      rules: [
        {
          id: "r0",
          condition: {
            kind: "field",
            fieldId: "f0",
            operator: "in",
            value: [c0Exact, c1, c2, c3, c4],
          },
          actions: [{ type: "show", targetFieldId: "f1" }],
        },
      ],
    };

    expect(Buffer.byteLength(JSON.stringify(exactRuleSet), "utf8")).toBe(262144);
    expect(normalizeFormRuleSet(exactRuleSet, baseFields).rules).toHaveLength(1);
    expect(evaluateConditionalForm({ fields: baseFields, historicalAnswers: [], ruleSet: exactRuleSet }).fieldStates).toHaveLength(2);

    const c0Over = c0Exact + "b";
    const overRuleSet = {
      schema: FORM_RULES_SCHEMA,
      ruleVersionId: "v1",
      rules: [
        {
          id: "r0",
          condition: {
            kind: "field",
            fieldId: "f0",
            operator: "in",
            value: [c0Over, c1, c2, c3, c4],
          },
          actions: [{ type: "show", targetFieldId: "f1" }],
        },
      ],
    };

    expect(Buffer.byteLength(JSON.stringify(overRuleSet), "utf8")).toBe(262145);
    expectError(() => normalizeFormRuleSet(overRuleSet, baseFields), "FORM_RULE_LIMIT_EXCEEDED");
    expectError(() => evaluateConditionalForm({ fields: baseFields, historicalAnswers: [], ruleSet: overRuleSet }), "FORM_RULE_LIMIT_EXCEEDED");
  });

  it("tests string-array operand duplicate/empty/non-string element rejection on real multipleChoice/ranking fields through both entry points and tests malformed historical array shapes", () => {
    const fields = [
      field("arr_mc", "multipleChoice"),
      field("arr_rk", "ranking"),
      field("target", "shortText", { defaultVisibility: "hidden" }),
    ];

    // Rule operand testing through both entry points
    const dupOperandRule = ruleSet([rule("r1", fieldCond("arr_mc", "equals", ["opt1", "opt1"]), [action("show", "target")])]);
    expectError(() => normalizeFormRuleSet(dupOperandRule, fields), "FORM_RULE_VALUE_INVALID");
    expectError(() => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: dupOperandRule }), "FORM_RULE_VALUE_INVALID");

    const emptyElemOperandRule = ruleSet([rule("r2", fieldCond("arr_rk", "equals", ["opt1", ""]), [action("show", "target")])]);
    expectError(() => normalizeFormRuleSet(emptyElemOperandRule, fields), "FORM_RULE_VALUE_INVALID");
    expectError(() => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: emptyElemOperandRule }), "FORM_RULE_VALUE_INVALID");

    const nonStrElemOperandRule = ruleSet([rule("r3", fieldCond("arr_mc", "equals", ["opt1", 123]), [action("show", "target")])]);
    expectError(() => normalizeFormRuleSet(nonStrElemOperandRule, fields), "FORM_RULE_VALUE_INVALID");
    expectError(() => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: nonStrElemOperandRule }), "FORM_RULE_VALUE_INVALID");

    // Historical answer testing through evaluateConditionalForm
    const validRule = ruleSet([rule("r_valid", fieldCond("arr_mc", "isEmpty"), [action("show", "target")])]);

    expectError(
      () => evaluateConditionalForm({ fields, historicalAnswers: [answer("arr_mc", ["opt1", "opt1"])], ruleSet: validRule }),
      "FORM_HISTORICAL_ANSWER_VALUE_INVALID",
    );
    expectError(
      () => evaluateConditionalForm({ fields, historicalAnswers: [answer("arr_rk", ["opt1", ""])], ruleSet: validRule }),
      "FORM_HISTORICAL_ANSWER_VALUE_INVALID",
    );
    expectError(
      () => evaluateConditionalForm({ fields, historicalAnswers: [answer("arr_mc", ["opt1", 123])], ruleSet: validRule }),
      "FORM_HISTORICAL_ANSWER_VALUE_INVALID",
    );
  });
});

describe("CFP Form Evaluator - Group 10: Deterministic Work-Budget Accounting", () => {
  it("proves multibyte exact and one-unit-over string work plus deterministic adversarial membership exhaustion", () => {
    const stringFields = [
      field("f1", "shortText"),
      field("f2", "shortText", { defaultVisibility: "hidden" }),
    ];
    const needle = "é".repeat(128);
    const haystack = "é".repeat(16_384);
    const needleBytes = Buffer.byteLength(needle, "utf8");
    const haystackBytes = Buffer.byteLength(haystack, "utf8");

    expect(needleBytes).toBe(256);
    expect(haystackBytes).toBe(32_768);
    expect(needle.length).toBe(128);
    expect(haystack.length).toBe(16_384);
    expect(haystackBytes * needleBytes).toBe(FORM_RULE_LIMITS.maxComparisonWork);
    expect(1 + haystackBytes * needleBytes).toBe(FORM_RULE_LIMITS.maxComparisonWork + 1);

    const exactStringRule = ruleSet([
      rule("r_exact_work", fieldCond("f1", "contains", needle), [action("show", "f2")]),
    ]);
    const exactStringResult = evaluateConditionalForm({
      fields: stringFields,
      historicalAnswers: [answer("f1", haystack)],
      ruleSet: exactStringRule,
    });
    expect(exactStringResult.fieldStates.find((state) => state.fieldId === "f2")?.visible).toBe(true);

    const overStringRule = ruleSet([
      rule(
        "r_over_work",
        { kind: "all", conditions: [fieldCond("f1", "isNotEmpty"), fieldCond("f1", "contains", needle)] },
        [action("show", "f2")],
      ),
    ]);
    expectError(
      () =>
        evaluateConditionalForm({
          fields: stringFields,
          historicalAnswers: [answer("f1", haystack)],
          ruleSet: overStringRule,
        }),
      "FORM_RULE_WORK_LIMIT_EXCEEDED",
    );

    const membershipFields = [
      field("membership", "shortText"),
      field("target", "shortText", { defaultVisibility: "hidden" }),
    ];
    const membershipCandidates = Array.from({ length: 64 }, (_, index) => `candidate_${index}`);
    expect(membershipCandidates).toHaveLength(64);
    expect(new Set(membershipCandidates).size).toBe(64);

    const inResult = evaluateConditionalForm({
      fields: membershipFields,
      historicalAnswers: [answer("membership", membershipCandidates[63])],
      ruleSet: ruleSet([
        rule("r_in_last", fieldCond("membership", "in", membershipCandidates), [action("show", "target")]),
      ]),
    });
    expect(inResult.fieldStates.find((state) => state.fieldId === "target")?.visible).toBe(true);

    const notInResult = evaluateConditionalForm({
      fields: membershipFields,
      historicalAnswers: [answer("membership", "absent_membership_value")],
      ruleSet: ruleSet([
        rule("r_not_in_absent", fieldCond("membership", "notIn", membershipCandidates), [action("show", "target")]),
      ]),
    });
    expect(notInResult.fieldStates.find((state) => state.fieldId === "target")?.visible).toBe(true);

    const fullElements = Array.from(
      { length: 1_024 },
      (_, index) => `${String(index).padStart(4, "0")}${"x".repeat(252)}`,
    );
    const partialElements = fullElements.slice(0, 896);
    const absentNeedle = "y".repeat(256);
    expect(fullElements).toHaveLength(1_024);
    expect(partialElements).toHaveLength(896);
    expect(new Set(fullElements).size).toBe(1_024);
    expect(new Set(partialElements).size).toBe(896);
    expect(fullElements.every((element) => Buffer.byteLength(element, "utf8") === 256)).toBe(true);
    expect(Buffer.byteLength(absentNeedle, "utf8")).toBe(256);

    const scanFields = [
      field("full_array", "multipleChoice"),
      field("partial_array", "multipleChoice"),
      field("scan_trigger", "shortText"),
      field("scan_target", "shortText", { defaultVisibility: "hidden" }),
    ];
    const scanHistory = [
      answer("full_array", fullElements),
      answer("partial_array", partialElements),
      answer("scan_trigger", "go"),
    ];

    const makeScanCondition = (nonEmptyChecks: number): Record<string, unknown> => {
      const leaves: Record<string, unknown>[] = [];
      for (let scan = 0; scan < 31; scan += 1) {
        leaves.push(fieldCond("full_array", "contains", fullElements[1_023]));
      }
      leaves.push(fieldCond("partial_array", "notContains", absentNeedle));
      for (let check = 0; check < nonEmptyChecks; check += 1) {
        leaves.push(fieldCond("scan_trigger", "isNotEmpty"));
      }

      const groups: Record<string, unknown>[] = [];
      for (let index = 0; index < leaves.length; index += 64) {
        groups.push({ kind: "all", conditions: leaves.slice(index, index + 64) });
      }
      return { kind: "all", conditions: groups };
    };

    const countConditionNodes = (condition: unknown): number => {
      if (condition === null || typeof condition !== "object" || Array.isArray(condition)) {
        return 0;
      }
      const candidate = condition as Record<string, unknown>;
      if (candidate.kind === "field") {
        return 1;
      }
      if (candidate.kind === "not") {
        return 1 + countConditionNodes(candidate.condition);
      }
      if (candidate.kind === "all" || candidate.kind === "any") {
        return 1 + (candidate.conditions as unknown[]).reduce<number>(
          (count, child) => count + countConditionNodes(child),
          0,
        );
      }
      return 0;
    };

    const assertConditionLimits = (condition: unknown): void => {
      if (condition === null || typeof condition !== "object" || Array.isArray(condition)) {
        return;
      }
      const candidate = condition as Record<string, unknown>;
      if (candidate.kind === "all" || candidate.kind === "any") {
        const children = candidate.conditions as unknown[];
        expect(children.length).toBeLessThanOrEqual(FORM_RULE_LIMITS.maxConditionChildren);
        for (const child of children) {
          assertConditionLimits(child);
        }
      } else if (candidate.kind === "not") {
        assertConditionLimits(candidate.condition);
      }
    };

    const exactScanCondition = makeScanCondition(128);
    const overScanCondition = makeScanCondition(129);
    expect(countConditionNodes(exactScanCondition)).toBe(164);
    expect(countConditionNodes(exactScanCondition)).toBeLessThanOrEqual(FORM_RULE_LIMITS.maxConditionNodes);
    expect(countConditionNodes(overScanCondition)).toBe(165);
    assertConditionLimits(exactScanCondition);
    assertConditionLimits(overScanCondition);

    const perElementWork = 1 + 256;
    const expectedScanWork = 31 * 1_024 * perElementWork + 896 * perElementWork + 128;
    expect(expectedScanWork).toBe(FORM_RULE_LIMITS.maxComparisonWork);
    expect(expectedScanWork + 1).toBe(FORM_RULE_LIMITS.maxComparisonWork + 1);

    const exactScanRuleSet = ruleSet([
      rule("r_scan_exact", exactScanCondition, [action("show", "scan_target")]),
    ]);
    expect(exactScanRuleSet.rules).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(exactScanRuleSet), "utf8")).toBeLessThan(
      FORM_RULE_LIMITS.maxSerializedBytes,
    );
    expect(scanFields).toHaveLength(4);
    expect(scanHistory).toHaveLength(3);
    expect(Buffer.byteLength(JSON.stringify({ fields: scanFields, historicalAnswers: scanHistory, ruleSet: exactScanRuleSet }), "utf8")).toBeLessThan(
      4 * 1024 * 1024,
    );
    expect(normalizeFormRuleSet(exactScanRuleSet, scanFields).rules).toHaveLength(1);

    const exactScanResult = evaluateConditionalForm({
      fields: scanFields,
      historicalAnswers: scanHistory,
      ruleSet: exactScanRuleSet,
    });
    expect(exactScanResult.fieldStates.find((state) => state.fieldId === "scan_target")?.visible).toBe(true);

    const overScanRuleSet = ruleSet([
      rule("r_scan_over", overScanCondition, [action("show", "scan_target")]),
    ]);
    expectError(
      () => evaluateConditionalForm({ fields: scanFields, historicalAnswers: scanHistory, ruleSet: overScanRuleSet }),
      "FORM_RULE_WORK_LIMIT_EXCEEDED",
    );

    const arrayContainsResult = evaluateConditionalForm({
      fields: scanFields,
      historicalAnswers: scanHistory,
      ruleSet: ruleSet([
        rule("r_array_last", fieldCond("full_array", "contains", fullElements[1_023]), [action("show", "scan_target")]),
      ]),
    });
    expect(arrayContainsResult.fieldStates.find((state) => state.fieldId === "scan_target")?.visible).toBe(true);

    const arrayNotContainsResult = evaluateConditionalForm({
      fields: scanFields,
      historicalAnswers: scanHistory,
      ruleSet: ruleSet([
        rule("r_array_absent", fieldCond("partial_array", "notContains", absentNeedle), [action("show", "scan_target")]),
      ]),
    });
    expect(arrayNotContainsResult.fieldStates.find((state) => state.fieldId === "scan_target")?.visible).toBe(true);
  });
});

describe("CFP Form Evaluator - Group 11: Comprehensive Safety Boundary & Hostile Input Parity", () => {
  it("pins independent rule-safety and complete-input precedence at 20,000/20,001 nodes", () => {
    const plainFields = [field("f0")];
    const countNodes = (value: unknown): number => {
      if (value === null || typeof value !== "object") {
        return 1;
      }
      if (Array.isArray(value)) {
        return 1 + value.reduce((count, child) => count + countNodes(child), 0);
      }
      return 1 + Object.values(value).reduce((count, child) => count + countNodes(child), 0);
    };

    const makeNodeRuleSet = (lastArrayLength: number): Record<string, unknown> => ({
      schema: FORM_RULES_SCHEMA,
      ruleVersionId: "v1",
      rules: [],
      extra: [
        ...Array.from({ length: 77 }, () => Array.from({ length: 256 }, () => null)),
        Array.from({ length: lastArrayLength }, () => null),
      ],
    });

    const exactAggregateRuleSet = makeNodeRuleSet(205);
    const overAggregateRuleSet = makeNodeRuleSet(206);
    expect(countNodes(exactAggregateRuleSet)).toBe(20_000);
    expect(countNodes(overAggregateRuleSet)).toBe(20_001);
    expectError(() => normalizeFormRuleSet(exactAggregateRuleSet, plainFields), "FORM_RULE_LIMIT_EXCEEDED");
    expectError(() => normalizeFormRuleSet(overAggregateRuleSet, plainFields), "FORM_RULE_LIMIT_EXCEEDED");

    for (const ruleSetValue of [exactAggregateRuleSet, overAggregateRuleSet]) {
      expectError(
        () => evaluateConditionalForm({ fields: plainFields, historicalAnswers: [], ruleSet: ruleSetValue }),
        "FORM_INPUT_UNSAFE",
      );
    }

    const ruleSafetyOverRuleSet: Record<string, unknown> = {
      schema: FORM_RULES_SCHEMA,
      ruleVersionId: "v1",
      rules: [],
      extra: [
        ...Array.from({ length: 31 }, () => Array.from({ length: 256 }, () => null)),
        Array.from({ length: 220 }, () => null),
      ],
    };
    expect(countNodes(ruleSafetyOverRuleSet)).toBe(8_193);
    let getterCalls = 0;
    const hostileFields: Record<string, unknown> = {};
    Object.defineProperty(hostileFields, "fieldAccessor", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return "HOSTILE_FIELD_SENTINEL";
      },
    });

    const normalizedError = captureError(() => normalizeFormRuleSet(ruleSafetyOverRuleSet, hostileFields));
    expect(normalizedError.code).toBe("FORM_RULE_LIMIT_EXCEEDED");
    const evaluatedError = captureError(() =>
      evaluateConditionalForm({ fields: hostileFields, historicalAnswers: [], ruleSet: ruleSafetyOverRuleSet }),
    );
    expect(evaluatedError.code).toBe("FORM_INPUT_UNSAFE");
    expect(getterCalls).toBe(0);
    expect(normalizedError.message).not.toContain("HOSTILE_FIELD_SENTINEL");
    expect(evaluatedError.message).not.toContain("HOSTILE_FIELD_SENTINEL");
  });

  it("classifies a dense rule array beyond private preflight capacity by entry point", () => {
    const fields = [field("f0")];
    const denseRules = Array.from({ length: 40_001 }, () => null);
    const denseRuleSet = ruleSet(denseRules);

    expect(denseRules).toHaveLength(40_001);
    expect(Object.keys(denseRules)).toHaveLength(40_001);
    expect(denseRules[0]).toBeNull();
    expect(denseRules[40_000]).toBeNull();

    expectError(() => normalizeFormRuleSet(denseRuleSet, fields), "FORM_RULE_LIMIT_EXCEEDED");
    expectError(
      () => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: denseRuleSet }),
      "FORM_INPUT_UNSAFE",
    );
  });

  it("regression: rejects raw accessor ruleSet after preceding oversized property without getter calls or sentinel leaks", () => {
    const fields = [field("f1")];

    let getterCalls = 0;
    const inputWithAccessorRuleSet: Record<string, unknown> = {
      fields,
      historicalAnswers: [],
      oversizedProp: "x".repeat(100000),
    };

    Object.defineProperty(inputWithAccessorRuleSet, "ruleSet", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return "SECRET_SENTINEL_PAYLOAD";
      },
    });

    const err = captureError(() => evaluateConditionalForm(inputWithAccessorRuleSet));
    expect(err.code).toBe("FORM_INPUT_UNSAFE");
    expect(getterCalls).toBe(0);
    expect(err.message).not.toContain("SECRET_SENTINEL_PAYLOAD");
  });

  it("classifies an enumerable rules accessor as unsafe regardless of oversized-sibling order through both entry points", () => {
    const fields = [field("f1")];

    const makeAccessorRuleSet = (oversizedBefore: boolean): { input: Record<string, unknown>; getCalls: () => number } => {
      const input: Record<string, unknown> = {
        schema: FORM_RULES_SCHEMA,
        ruleVersionId: "v1",
      };
      let getCalls = 0;
      const defineRulesAccessor = (): void => {
        Object.defineProperty(input, "rules", {
          configurable: true,
          enumerable: true,
          get() {
            getCalls += 1;
            return "RULES_ACCESSOR_SENTINEL";
          },
        });
      };

      if (oversizedBefore) {
        input.oversizedSibling = "x".repeat(100_000);
        defineRulesAccessor();
      } else {
        defineRulesAccessor();
        input.oversizedSibling = "x".repeat(100_000);
      }
      return { input, getCalls: () => getCalls };
    };

    for (const oversizedBefore of [true, false]) {
      const fixture = makeAccessorRuleSet(oversizedBefore);
      const normalizedError = captureError(() => normalizeFormRuleSet(fixture.input, fields));
      const evaluatedError = captureError(() =>
        evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: fixture.input }),
      );

      expect(normalizedError.code).toBe("FORM_INPUT_UNSAFE");
      expect(evaluatedError.code).toBe("FORM_INPUT_UNSAFE");
      expect(fixture.getCalls()).toBe(0);
      expect(normalizedError.message).not.toContain("RULES_ACCESSOR_SENTINEL");
      expect(evaluatedError.message).not.toContain("RULES_ACCESSOR_SENTINEL");
    }
  });

  it("inspects a per-container-valid 20,000-node data subtree before a later nested accessor regardless of sibling order", () => {
    const fields = [field("f1")];
    const aggregateNodeLimit = 20_000;

    const countDataNodes = (value: unknown): number => {
      if (Array.isArray(value)) {
        let count = 1;
        for (let index = 0; index < value.length; index += 1) {
          count += countDataNodes(value[index]);
        }
        return count;
      }
      return 1;
    };

    const makeDataOnlySubtree = (): unknown[] => [
      ...Array.from({ length: 77 }, () => Array.from({ length: 256 }, () => null)),
      Array.from({ length: 205 }, () => null),
    ];

    const makeFixture = (largeBefore: boolean): {
      readonly ruleSet: Record<string, unknown>;
      readonly getCalls: () => number;
    } => {
      const dataOnlySubtree = makeDataOnlySubtree();
      expect(countDataNodes(dataOnlySubtree) + 4).toBe(aggregateNodeLimit);

      let getterCalls = 0;
      const nestedAccessorContainer: Record<string, unknown> = {};
      Object.defineProperty(nestedAccessorContainer, "nestedAccessor", {
        configurable: true,
        enumerable: true,
        get() {
          getterCalls += 1;
          return "NESTED_ACCESSOR_SENTINEL";
        },
      });

      const laterSibling = { nested: nestedAccessorContainer };
      const input: Record<string, unknown> = {
        schema: FORM_RULES_SCHEMA,
        ruleVersionId: "v1",
        rules: [],
      };
      if (largeBefore) {
        input.dataOnlySubtree = dataOnlySubtree;
        input.laterSibling = laterSibling;
      } else {
        input.laterSibling = laterSibling;
        input.dataOnlySubtree = dataOnlySubtree;
      }
      return { ruleSet: input, getCalls: () => getterCalls };
    };

    for (const largeBefore of [true, false]) {
      const fixture = makeFixture(largeBefore);
      const normalizedError = captureError(() => normalizeFormRuleSet(fixture.ruleSet, fields));
      const evaluatedError = captureError(() =>
        evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: fixture.ruleSet }),
      );

      expect(normalizedError.code).toBe("FORM_INPUT_UNSAFE");
      expect(evaluatedError.code).toBe("FORM_INPUT_UNSAFE");
      expect(fixture.getCalls()).toBe(0);
      expect(normalizedError.message).not.toContain("NESTED_ACCESSOR_SENTINEL");
      expect(evaluatedError.message).not.toContain("NESTED_ACCESSOR_SENTINEL");
    }
  });

  it("rejects ordinary accessors and cycles through both public entry points without invoking getters", () => {
    const fields = [field("f1"), field("target")];
    let getterCalls = 0;
    const accessorRuleSet = ruleSet([]);
    Object.defineProperty(accessorRuleSet, "rules", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return "ACCESSOR_SENTINEL_VALUE";
      },
    });

    const normalizedAccessorError = captureError(() => normalizeFormRuleSet(accessorRuleSet, fields));
    expect(normalizedAccessorError.code).toBe("FORM_INPUT_UNSAFE");
    const evaluatedAccessorError = captureError(() =>
      evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: accessorRuleSet }),
    );
    expect(evaluatedAccessorError.code).toBe("FORM_INPUT_UNSAFE");
    expect(getterCalls).toBe(0);
    expect(normalizedAccessorError.message).not.toContain("ACCESSOR_SENTINEL");
    expect(evaluatedAccessorError.message).not.toContain("ACCESSOR_SENTINEL");

    const cyclicRuleSet = ruleSet([]);
    (cyclicRuleSet.rules as unknown[]).push(cyclicRuleSet);
    expectError(() => normalizeFormRuleSet(cyclicRuleSet, fields), "FORM_INPUT_UNSAFE");
    expectError(
      () => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: cyclicRuleSet }),
      "FORM_INPUT_UNSAFE",
    );
  });

  it("tests hostile-input parity: forbidden own keys and unsafe values through both entry points", () => {
    const fields = [field("f1"), field("target")];

    // Forbidden own key __proto__ through both entry points
    const protoKeyInput = JSON.parse('{"__proto__": {}, "schema": "cfp-form-rules/v1", "ruleVersionId": "v1", "rules": []}');
    expectError(() => normalizeFormRuleSet(protoKeyInput, fields), "FORM_INPUT_UNSAFE");
    expectError(() => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: protoKeyInput }), "FORM_INPUT_UNSAFE");

    // Forbidden own key constructor through both entry points
    const ctorKeyInput = { constructor: {}, schema: FORM_RULES_SCHEMA, ruleVersionId: "v1", rules: [] };
    expectError(() => normalizeFormRuleSet(ctorKeyInput, fields), "FORM_INPUT_UNSAFE");
    expectError(() => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: ctorKeyInput }), "FORM_INPUT_UNSAFE");

    // Unsafe history values remain evaluator-only because normalization accepts no history.
    expectError(() => evaluateConditionalForm({ fields, historicalAnswers: [answer("f1", NaN)], ruleSet: ruleSet([]) }), "FORM_INPUT_UNSAFE");
    expectError(() => evaluateConditionalForm({ fields, historicalAnswers: [answer("f1", Infinity)], ruleSet: ruleSet([]) }), "FORM_INPUT_UNSAFE");
    expectError(() => evaluateConditionalForm({ fields, historicalAnswers: [answer("f1", Symbol("sym"))], ruleSet: ruleSet([]) }), "FORM_INPUT_UNSAFE");
    expectError(() => evaluateConditionalForm({ fields, historicalAnswers: [answer("f1", "\uD800")], ruleSet: ruleSet([]) }), "FORM_INPUT_UNSAFE");

    // The same unsafe values in rule operands must fail identically in both entry points.
    const unsafeRuleOperands: unknown[] = [
      NaN,
      Infinity,
      Symbol("RULE_OPERAND_SYMBOL_SENTINEL"),
      "\uD800",
    ];
    for (const unsafeOperand of unsafeRuleOperands) {
      const unsafeRuleSet = ruleSet([
        rule("r_unsafe_operand", fieldCond("f1", "equals", unsafeOperand), [action("show", "target")]),
      ]);
      const normalizedError = captureError(() => normalizeFormRuleSet(unsafeRuleSet, fields));
      expect(normalizedError.code).toBe("FORM_INPUT_UNSAFE");
      const evaluatedError = captureError(() =>
        evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: unsafeRuleSet }),
      );
      expect(evaluatedError.code).toBe("FORM_INPUT_UNSAFE");
      expect(normalizedError.message).not.toContain("RULE_OPERAND_SYMBOL_SENTINEL");
      expect(evaluatedError.message).not.toContain("RULE_OPERAND_SYMBOL_SENTINEL");
    }

    const symbolKeyRuleSet = ruleSet([]) as Record<PropertyKey, unknown>;
    Object.defineProperty(symbolKeyRuleSet, Symbol("OWN_SYMBOL_KEY_SENTINEL"), {
      enumerable: true,
      value: "OWN_SYMBOL_VALUE_SENTINEL",
    });
    const normalizedSymbolKeyError = captureError(() => normalizeFormRuleSet(symbolKeyRuleSet, fields));
    expect(normalizedSymbolKeyError.code).toBe("FORM_INPUT_UNSAFE");
    const evaluatedSymbolKeyError = captureError(() =>
      evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: symbolKeyRuleSet }),
    );
    expect(evaluatedSymbolKeyError.code).toBe("FORM_INPUT_UNSAFE");
    expect(normalizedSymbolKeyError.message).not.toContain("OWN_SYMBOL");
    expect(evaluatedSymbolKeyError.message).not.toContain("OWN_SYMBOL");
  });

  it("maps each distinct rule safety code family (depth, string, array, object, node, serialized size) through both entry points with non-reflective results", () => {
    const fields = [field("f1")];

    // 1. DEPTH_LIMIT
    const deepObj: Record<string, unknown> = { schema: FORM_RULES_SCHEMA, ruleVersionId: "v1", rules: [] };
    let curr = deepObj;
    for (let i = 0; i < 35; i += 1) {
      const next: Record<string, unknown> = {};
      curr.nested = next;
      curr = next;
    }
    const errNormDepth = captureError(() => normalizeFormRuleSet(deepObj, fields));
    expect(errNormDepth.code).toBe("FORM_RULE_LIMIT_EXCEEDED");
    expect(errNormDepth.message).toBe("The form rule set exceeds a structural limit.");

    const errEvalDepth = captureError(() => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: deepObj }));
    expect(errEvalDepth.code).toBe("FORM_RULE_LIMIT_EXCEEDED");
    expect(errEvalDepth.message).toBe("The form rule set exceeds a structural limit.");

    // 2. STRING_LIMIT (string length > 64 KiB = 65,536 bytes)
    const longStringObj = { schema: FORM_RULES_SCHEMA, ruleVersionId: "v1", rules: [], extra: "x".repeat(70000) };
    expectError(() => normalizeFormRuleSet(longStringObj, fields), "FORM_RULE_LIMIT_EXCEEDED");
    expectError(() => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: longStringObj }), "FORM_RULE_LIMIT_EXCEEDED");

    // 3. ARRAY_LIMIT (array length > 256)
    const longArrayObj = { schema: FORM_RULES_SCHEMA, ruleVersionId: "v1", rules: [], extra: Array.from({ length: 300 }, () => 1) };
    expectError(() => normalizeFormRuleSet(longArrayObj, fields), "FORM_RULE_LIMIT_EXCEEDED");
    expectError(() => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: longArrayObj }), "FORM_RULE_LIMIT_EXCEEDED");

    // 4. OBJECT_LIMIT (object keys > 32)
    const manyKeysObj: Record<string, unknown> = { schema: FORM_RULES_SCHEMA, ruleVersionId: "v1", rules: [] };
    for (let i = 0; i < 35; i += 1) {
      manyKeysObj[`k_${i}`] = i;
    }
    expectError(() => normalizeFormRuleSet(manyKeysObj, fields), "FORM_RULE_LIMIT_EXCEEDED");
    expectError(() => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: manyKeysObj }), "FORM_RULE_LIMIT_EXCEEDED");

    // 5. NODE_LIMIT (shallow arrays exceed 8,192 walk nodes without another limit first)
    const manyNodesObj: Record<string, unknown> = {
      schema: FORM_RULES_SCHEMA,
      ruleVersionId: "v1",
      rules: [],
      extra: Array.from({ length: 32 }, () => Array.from({ length: 256 }, () => null)),
    };
    const inspectShape = (value: unknown, depth = 0): {
      nodes: number;
      maxArrayLength: number;
      maxObjectKeys: number;
      maxDepth: number;
    } => {
      const stats = { nodes: 1, maxArrayLength: 0, maxObjectKeys: 0, maxDepth: depth };
      if (Array.isArray(value)) {
        stats.maxArrayLength = value.length;
        for (const child of value) {
          const childStats = inspectShape(child, depth + 1);
          stats.nodes += childStats.nodes;
          stats.maxArrayLength = Math.max(stats.maxArrayLength, childStats.maxArrayLength);
          stats.maxObjectKeys = Math.max(stats.maxObjectKeys, childStats.maxObjectKeys);
          stats.maxDepth = Math.max(stats.maxDepth, childStats.maxDepth);
        }
      } else if (value !== null && typeof value === "object") {
        const entries = Object.values(value);
        stats.maxObjectKeys = entries.length;
        for (const child of entries) {
          const childStats = inspectShape(child, depth + 1);
          stats.nodes += childStats.nodes;
          stats.maxArrayLength = Math.max(stats.maxArrayLength, childStats.maxArrayLength);
          stats.maxObjectKeys = Math.max(stats.maxObjectKeys, childStats.maxObjectKeys);
          stats.maxDepth = Math.max(stats.maxDepth, childStats.maxDepth);
        }
      }
      return stats;
    };
    const shapeStats = inspectShape(manyNodesObj);
    expect(shapeStats.maxArrayLength).toBeLessThanOrEqual(256);
    expect(shapeStats.maxObjectKeys).toBeLessThanOrEqual(32);
    expect(shapeStats.maxDepth).toBeLessThan(32);
    expect(Buffer.byteLength(JSON.stringify(manyNodesObj), "utf8")).toBeLessThan(262_144);
    expect(shapeStats.nodes).toBeGreaterThan(8_192);
    expectError(() => normalizeFormRuleSet(manyNodesObj, fields), "FORM_RULE_LIMIT_EXCEEDED");
    expectError(() => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: manyNodesObj }), "FORM_RULE_LIMIT_EXCEEDED");

    // 6. SERIALIZED_SIZE_LIMIT (serialized size > 256 KiB = 262,144)
    const str55KB = "x".repeat(55 * 1024);
    const bigSerializedObj = ruleSet(
      Array.from({ length: 5 }, (_, i) => rule(`r_f_${i}`, fieldCond("f1", "equals", str55KB), [action("show", "f1")]))
    );
    expectError(() => normalizeFormRuleSet(bigSerializedObj, fields), "FORM_RULE_LIMIT_EXCEEDED");
    expectError(() => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: bigSerializedObj }), "FORM_RULE_LIMIT_EXCEEDED");
  });

  it("audits exact and one-over rule safety walk boundaries with evaluator/normalizer parity", () => {
    const fields = [field("f0"), field("f1")];

    const expectBoundaryError = (
      exactInput: unknown,
      exactCode: FormEvaluationErrorCode,
      overInput: unknown,
    ): void => {
      expectError(() => normalizeFormRuleSet(exactInput, fields), exactCode);
      expectError(
        () => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: exactInput }),
        exactCode,
      );
      expectError(() => normalizeFormRuleSet(overInput, fields), "FORM_RULE_LIMIT_EXCEEDED");
      expectError(
        () => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: overInput }),
        "FORM_RULE_LIMIT_EXCEEDED",
      );
    };

    const makeNestedRuleSet = (nestedCount: number): Record<string, unknown> => {
      const root: Record<string, unknown> = { schema: FORM_RULES_SCHEMA, ruleVersionId: "v1", rules: [] };
      let cursor = root;
      for (let index = 0; index < nestedCount; index += 1) {
        const next: Record<string, unknown> = {};
        cursor.nested = next;
        cursor = next;
      }
      return root;
    };
    const exactDepth = makeNestedRuleSet(32);
    const overDepth = makeNestedRuleSet(33);
    // The exact-depth fixture is intentionally rejected only after the safety walk by shape parsing.
    expectBoundaryError(exactDepth, "FORM_RULE_SET_INVALID", overDepth);

    const nonRuleNodeBudgetFixture = Array.from({ length: 20 }, (_, index) =>
      Array.from({ length: index < 10 ? 998 : 997 }, () => null),
    );
    expectError(
      () =>
        evaluateConditionalForm({
          fields,
          historicalAnswers: [],
          ruleSet: exactDepth,
          extra: nonRuleNodeBudgetFixture,
        }),
      "FORM_INPUT_UNSAFE",
    );

    const exactString = "s".repeat(64 * 1024);
    const overString = "s".repeat(64 * 1024 + 1);
    const exactStringRuleSet = ruleSet([
      rule("r_string_exact", fieldCond("f0", "equals", exactString), [action("show", "f1")]),
    ]);
    const overStringRuleSet = ruleSet([
      rule("r_string_over", fieldCond("f0", "equals", overString), [action("show", "f1")]),
    ]);
    expect(Buffer.byteLength(exactString, "utf8")).toBe(64 * 1024);
    expect(Buffer.byteLength(overString, "utf8")).toBe(64 * 1024 + 1);
    expect(normalizeFormRuleSet(exactStringRuleSet, fields).rules).toHaveLength(1);
    expect(evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: exactStringRuleSet }).fieldStates).toHaveLength(2);
    expectError(() => normalizeFormRuleSet(overStringRuleSet, fields), "FORM_RULE_LIMIT_EXCEEDED");
    expectError(
      () => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: overStringRuleSet }),
      "FORM_RULE_LIMIT_EXCEEDED",
    );

    const exactArrayRuleSet = ruleSet(
      Array.from({ length: 256 }, (_, index) =>
        rule(`r_array_${index}`, fieldCond("f0", "isEmpty"), [action("show", "f1")]),
      ),
    );
    const overArrayRuleSet = ruleSet([
      ...(exactArrayRuleSet.rules as unknown[]),
      rule("r_array_256", fieldCond("f0", "isEmpty"), [action("show", "f1")]),
    ]);
    expect(normalizeFormRuleSet(exactArrayRuleSet, fields).rules).toHaveLength(256);
    expect(evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: exactArrayRuleSet }).fieldStates).toHaveLength(2);
    expectError(() => normalizeFormRuleSet(overArrayRuleSet, fields), "FORM_RULE_LIMIT_EXCEEDED");
    expectError(
      () => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: overArrayRuleSet }),
      "FORM_RULE_LIMIT_EXCEEDED",
    );

    const makeObjectKeyRuleSet = (extraKeyCount: number): Record<string, unknown> => {
      const result = ruleSet([]);
      for (let index = 0; index < extraKeyCount; index += 1) {
        result[`extra_${index}`] = index;
      }
      return result;
    };
    expectBoundaryError(
      makeObjectKeyRuleSet(29),
      "FORM_RULE_SET_INVALID",
      makeObjectKeyRuleSet(30),
    );

    const countNodes = (value: unknown): number => {
      if (value === null || typeof value !== "object") {
        return 1;
      }
      if (Array.isArray(value)) {
        return 1 + value.reduce<number>((count, child) => count + countNodes(child), 0);
      }
      return 1 + Object.values(value).reduce<number>((count, child) => count + countNodes(child), 0);
    };
    const makeNodeRuleSet = (lastArrayLength: number): Record<string, unknown> => ({
      schema: FORM_RULES_SCHEMA,
      ruleVersionId: "v1",
      rules: [],
      extra: [
        ...Array.from({ length: 31 }, () => Array.from({ length: 256 }, () => null)),
        Array.from({ length: lastArrayLength }, () => null),
      ],
    });
    const exactNodeRuleSet = makeNodeRuleSet(219);
    const overNodeRuleSet = makeNodeRuleSet(220);
    expect(countNodes(exactNodeRuleSet)).toBe(8_192);
    expect(countNodes(overNodeRuleSet)).toBe(8_193);
    expectBoundaryError(exactNodeRuleSet, "FORM_RULE_SET_INVALID", overNodeRuleSet);
  });

  it("proves exact and one-over aggregate node and UTF-8 byte fallback boundaries on recombined evaluator input", () => {
    const aggregateNodeLimit = 20_000;
    const aggregateByteLimit = 4 * 1024 * 1024;
    const fields = [field("f0", "shortText")];

    const makeDepthBoundaryRuleSet = (): Record<string, unknown> => {
      const root: Record<string, unknown> = {
        schema: FORM_RULES_SCHEMA,
        ruleVersionId: "v1",
        rules: [],
      };
      let cursor = root;
      for (let index = 0; index < 32; index += 1) {
        const next: Record<string, unknown> = {};
        cursor.nested = next;
        cursor = next;
      }
      return root;
    };

    const makeAggregateInput = (config: unknown): Record<string, unknown> => ({
      ruleSet: makeDepthBoundaryRuleSet(),
      fields: [field("f0", "shortText", { config })],
      historicalAnswers: [],
    });

    const countNodes = (value: unknown): number => {
      if (value === null || typeof value !== "object") {
        return 1;
      }
      if (Array.isArray(value)) {
        return 1 + value.reduce<number>((count, child) => count + countNodes(child), 0);
      }
      return 1 + Object.values(value).reduce<number>((count, child) => count + countNodes(child), 0);
    };

    const makeNodeConfig = (lastLength: number): unknown[] => [
      ...Array.from({ length: 19 }, () => Array.from({ length: 1_024 }, () => null)),
      Array.from({ length: lastLength }, () => null),
    ];
    const nodeProbe = makeAggregateInput(makeNodeConfig(0));
    const nodeRemainder = aggregateNodeLimit - countNodes(nodeProbe);
    expect(nodeRemainder).toBeGreaterThanOrEqual(0);
    expect(nodeRemainder + 1).toBeLessThanOrEqual(1_024);

    const exactNodeInput = makeAggregateInput(makeNodeConfig(nodeRemainder));
    const overNodeInput = makeAggregateInput(makeNodeConfig(nodeRemainder + 1));
    expect(countNodes(exactNodeInput)).toBe(aggregateNodeLimit);
    expect(countNodes(overNodeInput)).toBe(aggregateNodeLimit + 1);
    expect(Buffer.byteLength(JSON.stringify(exactNodeInput), "utf8")).toBeLessThan(aggregateByteLimit);
    const exactNodeConfig = (exactNodeInput.fields as Array<Record<string, unknown>>)[0]!.config;
    expect(Array.isArray(exactNodeConfig)).toBe(true);
    if (Array.isArray(exactNodeConfig)) {
      for (const item of exactNodeConfig) {
        expect(Array.isArray(item)).toBe(true);
        if (Array.isArray(item)) {
          expect(item.length).toBeLessThanOrEqual(1_024);
        }
      }
    }
    expectError(
      () => evaluateConditionalForm({ ...exactNodeInput }),
      "FORM_RULE_SET_INVALID",
    );
    expectError(
      () => evaluateConditionalForm({ ...overNodeInput }),
      "FORM_INPUT_UNSAFE",
    );

    const fullString = `\n${"é".repeat(32_767)}a`;
    const makeMultibyteString = (length: number): string => {
      if (length === 0) {
        return "";
      }
      const multibyteLength = Math.floor(length / 2);
      return `${"é".repeat(multibyteLength)}${length % 2 === 1 ? "a" : ""}`;
    };
    expect(Buffer.byteLength(fullString, "utf8")).toBe(64 * 1024);
    expect(fullString.length).toBe(32_769);
    expect(Buffer.byteLength(JSON.stringify(fullString), "utf8")).toBe(64 * 1024 + 3);
    expect(JSON.stringify(fullString)).toContain("\\n");

    const makeByteConfig = (variableLengths: readonly number[]): string[] => [
      ...Array.from({ length: 60 }, () => fullString),
      ...variableLengths.map((length) => makeMultibyteString(length)),
    ];
    const byteProbe = makeAggregateInput(makeByteConfig([0, 0, 0, 0]));
    const byteRemainder = aggregateByteLimit - Buffer.byteLength(JSON.stringify(byteProbe), "utf8");
    expect(byteRemainder).toBeGreaterThanOrEqual(0);
    expect(byteRemainder).toBeLessThanOrEqual(4 * 64 * 1024 - 1);

    const distributeBytes = (total: number): number[] => {
      const lengths: number[] = [];
      let remaining = total;
      for (let index = 0; index < 4; index += 1) {
        const length = Math.min(64 * 1024, remaining);
        lengths.push(length);
        remaining -= length;
      }
      expect(remaining).toBe(0);
      return lengths;
    };
    const exactByteInput = makeAggregateInput(makeByteConfig(distributeBytes(byteRemainder)));
    const overByteInput = makeAggregateInput(makeByteConfig(distributeBytes(byteRemainder + 1)));
    const exactByteConfigValues = (exactByteInput.fields as Array<Record<string, unknown>>)[0]!.config;
    const overByteConfigValues = (overByteInput.fields as Array<Record<string, unknown>>)[0]!.config;
    expect(Array.isArray(exactByteConfigValues)).toBe(true);
    expect(Array.isArray(overByteConfigValues)).toBe(true);
    if (Array.isArray(exactByteConfigValues) && Array.isArray(overByteConfigValues)) {
      const exactRawConfigBytes = exactByteConfigValues.reduce(
        (total, value) => total + Buffer.byteLength(value as string, "utf8"),
        0,
      );
      const overRawConfigBytes = overByteConfigValues.reduce(
        (total, value) => total + Buffer.byteLength(value as string, "utf8"),
        0,
      );
      expect(overRawConfigBytes).toBe(exactRawConfigBytes + 1);
      expect(exactRawConfigBytes).toBe(60 * (64 * 1024) + byteRemainder);
    }
    expect(Buffer.byteLength(JSON.stringify(exactByteInput), "utf8")).toBe(aggregateByteLimit);
    expect(Buffer.byteLength(JSON.stringify(overByteInput), "utf8")).toBe(aggregateByteLimit + 1);
    const exactByteConfig = (exactByteInput.fields as Array<Record<string, unknown>>)[0]!.config;
    expect(Array.isArray(exactByteConfig)).toBe(true);
    if (Array.isArray(exactByteConfig)) {
      expect(exactByteConfig.length).toBeLessThanOrEqual(1_024);
      for (const item of exactByteConfig) {
        expect(typeof item).toBe("string");
        if (typeof item === "string") {
          expect(Buffer.byteLength(item, "utf8")).toBeLessThanOrEqual(64 * 1024);
        }
      }
    }
    expectError(
      () => evaluateConditionalForm({ ...exactByteInput }),
      "FORM_RULE_SET_INVALID",
    );
    expectError(
      () => evaluateConditionalForm({ ...overByteInput }),
      "FORM_INPUT_UNSAFE",
    );
  });

  it("rejects proxies, revoked proxies, sparse arrays, symbols, and custom class instances safely with FORM_INPUT_UNSAFE", () => {
    const fields = [field("f1")];

    let proxyCalls = 0;
    const proxyInput = new Proxy(
      {},
      {
        ownKeys() {
          proxyCalls += 1;
          throw new Error("HOSTILE_TRAP");
        },
      },
    );

    const errNormProxy = captureError(() => normalizeFormRuleSet(proxyInput, fields));
    expect(errNormProxy.code).toBe("FORM_INPUT_UNSAFE");
    expect(proxyCalls).toBe(0);
    expect(errNormProxy.message).not.toContain("HOSTILE");

    const errEvalProxy = captureError(() => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: proxyInput }));
    expect(errEvalProxy.code).toBe("FORM_INPUT_UNSAFE");
    expect(proxyCalls).toBe(0);
    expect(errEvalProxy.message).not.toContain("HOSTILE");

    const { proxy: revProxy, revoke } = Proxy.revocable({}, {});
    revoke();

    expectError(() => normalizeFormRuleSet(revProxy, fields), "FORM_INPUT_UNSAFE");
    expectError(() => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: revProxy }), "FORM_INPUT_UNSAFE");

    const sparseArr: unknown[] = ["a"];
    sparseArr[3] = "b";

    expectError(() => normalizeFormRuleSet({ schema: FORM_RULES_SCHEMA, ruleVersionId: "v1", rules: sparseArr }, fields), "FORM_INPUT_UNSAFE");
    expectError(() => evaluateConditionalForm({ fields, historicalAnswers: sparseArr, ruleSet: ruleSet([]) }), "FORM_INPUT_UNSAFE");

    class CustomClass {
      schema = FORM_RULES_SCHEMA;
      ruleVersionId = "v1";
      rules = [];
    }
    const customInstance = new CustomClass();
    expectError(() => normalizeFormRuleSet(customInstance, fields), "FORM_INPUT_UNSAFE");
    expectError(() => evaluateConditionalForm({ fields, historicalAnswers: [], ruleSet: customInstance }), "FORM_INPUT_UNSAFE");
  });
});

describe("CFP Form Evaluator - Group 12: Deep Freeze, Detachment & Display Ordering", () => {
  it("verifies normalized nested rule literal freeze, nested opaque effective-answer freeze, and caller mutation detachment", () => {
    const f0 = field("f0", "multipleChoice");
    const f1 = field("f1");
    const addrField = field("addr", "address");
    const fields = [f0, f1, addrField];

    const nestedOperand = ["a", "b"];
    const nestedCondition: Record<string, unknown> = {
      kind: "all",
      conditions: [{ kind: "field", fieldId: "f0", operator: "equals", value: nestedOperand }],
    };
    const nestedAction = { type: "show", targetFieldId: "f1" };
    const r0 = rule("r0", nestedCondition, [nestedAction]);
    const rSet = ruleSet([r0]);

    // 1. Normalized nested rule literal freeze
    const norm = normalizeFormRuleSet(rSet, fields);
    expect(Object.isFrozen(norm)).toBe(true);
    expect(Object.isFrozen(norm.rules)).toBe(true);
    expect(Object.isFrozen(norm.rules[0])).toBe(true);
    expect(Object.isFrozen(norm.rules[0]!.condition)).toBe(true);
    if (norm.rules[0]!.condition.kind === "all") {
      expect(Object.isFrozen(norm.rules[0]!.condition.conditions)).toBe(true);
      expect(Object.isFrozen(norm.rules[0]!.condition.conditions[0])).toBe(true);
      const normalizedLeaf = norm.rules[0]!.condition.conditions[0]!;
      expect(normalizedLeaf.kind).toBe("field");
      if (normalizedLeaf.kind === "field") {
        expect(normalizedLeaf).toEqual({
          kind: "field",
          fieldId: "f0",
          operator: "equals",
          value: ["a", "b"],
        });
        expect(Object.isFrozen(normalizedLeaf.value as object)).toBe(true);
      }
    }
    expect(Object.isFrozen(norm.rules[0]!.actions)).toBe(true);
    expect(Object.isFrozen(norm.rules[0]!.actions[0])).toBe(true);

    // 2. Nested opaque effective-answer freeze
    const opaqueValue = { street: "123 Main St", meta: { zip: "12345", verified: true } };
    const opaqueHistory = [answer("f0", ["a", "b"]), answer("addr", opaqueValue)];
    const resEval = evaluateConditionalForm({
      fields,
      historicalAnswers: opaqueHistory,
      ruleSet: rSet,
    });

    expect(Object.isFrozen(resEval)).toBe(true);
    expect(Object.isFrozen(resEval.effectiveAnswers)).toBe(true);
    const addrAns = resEval.effectiveAnswers.find((a) => a.fieldId === "addr")!;
    expect(Object.isFrozen(addrAns)).toBe(true);
    expect(Object.isFrozen(addrAns.value)).toBe(true);
    expect(Object.isFrozen((addrAns.value as Record<string, unknown>).meta)).toBe(true);
    opaqueValue.street = "caller-mutated-street";
    (opaqueValue.meta as Record<string, unknown>).zip = "caller-mutated-zip";
    opaqueHistory[1]!.value = { replaced: true };
    expect(addrAns.value).toEqual({ street: "123 Main St", meta: { zip: "12345", verified: true } });

    nestedOperand.push("caller-mutated");
    (nestedCondition.conditions as unknown[]).push(fieldCond("f0", "isEmpty"));
    nestedAction.targetFieldId = "f0";
    if (norm.rules[0]!.condition.kind === "all") {
      expect(norm.rules[0]!.condition.conditions).toHaveLength(1);
      expect(norm.rules[0]!.condition.conditions[0]).toEqual({
        kind: "field",
        fieldId: "f0",
        operator: "equals",
        value: ["a", "b"],
      });
    }
    expect(norm.rules[0]!.actions[0]).toEqual({ type: "show", targetFieldId: "f1" });

    // 3. Caller mutation detachment check
    const callerFields = [field("f0"), field("f1")];
    const callerRules = ruleSet([rule("r0", fieldCond("f0", "isNotEmpty"), [action("show", "f1")])]);
    const callerHistory = [answer("f0", "val")];

    const normBeforeMut = normalizeFormRuleSet(callerRules, callerFields);
    const evalBeforeMut = evaluateConditionalForm({ fields: callerFields, historicalAnswers: callerHistory, ruleSet: callerRules });

    // Mutate caller objects post evaluation
    (callerFields as any).push(field("f2"));
    (callerRules as any).ruleVersionId = "mutated_v2";
    (callerHistory[0] as any).value = "mutated_val";

    expect(normBeforeMut.ruleVersionId).toBe("rules-v1");
    expect(evalBeforeMut.ruleVersionId).toBe("rules-v1");
    expect(evalBeforeMut.fieldStates.map((s) => s.fieldId)).toEqual(["f0", "f1"]);
    expect(evalBeforeMut.effectiveAnswers[0]!.value).toBe("val");
  });

  it("returns display-ordered fieldStates and W1-F1 sorted effective answers", () => {
    const fields = [
      field("z_last", "shortText"),
      field("a_first", "shortText"),
      field("m_mid", "shortText"),
    ];

    const history = [
      answer("m_mid", "val_m"),
      answer("z_last", "val_z"),
      answer("a_first", "val_a"),
    ];

    const result = evaluateConditionalForm({ fields, historicalAnswers: history, ruleSet: ruleSet([]) });

    expect(result.fieldStates.map((s) => s.fieldId)).toEqual(["z_last", "a_first", "m_mid"]);
    expect(result.effectiveAnswers.map((a) => a.fieldId)).toEqual(["a_first", "m_mid", "z_last"]);

    const sortedByHelper = [...result.effectiveAnswers].sort((x, y) => compareFormFieldIds(x.fieldId, y.fieldId));
    expect(result.effectiveAnswers).toEqual(sortedByHelper);
  });
});

describe("CFP Form Evaluator - Group 13: FormEvaluatorError Export and Consistency", () => {
  it("exports FormEvaluatorError alias and FormEvaluationError with stable codes and non-reflective messages", () => {
    expect(FormEvaluatorError).toBe(FormEvaluationError);

    const err = new FormEvaluatorError("FORM_RULE_ACTION_CONFLICT");
    expect(err.name).toBe("FormEvaluationError");
    expect(err.code).toBe("FORM_RULE_ACTION_CONFLICT");
    expect(err.message).toBe("Matched form rules demand conflicting actions.");
  });
});
