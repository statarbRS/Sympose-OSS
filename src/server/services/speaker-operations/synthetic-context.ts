import { deterministicUuid } from "../../canonical";
import type { SpeakerEventInitialization } from "./contracts";

const EVALUATOR_WORKSPACE_ID = deterministicUuid("workspace:acme");
const EVALUATOR_EVENT_ID = deterministicUuid("evaluator-demo:event:acme");

export function speakerEventInitializationFor(workspaceId: string, eventId: string): SpeakerEventInitialization {
  return {
    kind: workspaceId === EVALUATOR_WORKSPACE_ID && eventId === EVALUATOR_EVENT_ID
      ? "evaluator-demo"
      : "ordinary",
  };
}
