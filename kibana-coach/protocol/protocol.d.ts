// The learning service's protocol with the coach (and the launcher), as learning-service/server.py
// sends it. Strict on purpose: every field is named, optional only where the server omits it, and
// nullable only where it sends null. scripts/generate-protocol-samples.py samples every variant from
// the real server code; `npm run check:protocol` checks those samples and the coach's JSDoc against
// this file. Change the server and this declaration together.

type NonEmpty<T> = [T, ...T[]];

export type Mode = 'demonstration' | 'guided' | 'challenge';
export type RunState = 'CREATED' | 'ACTIVATING' | 'WARMING' | 'READY' | 'INVESTIGATING' | 'COMPLETED' | 'FAILED' | 'ABORTED';
export type ScenarioType = 'investigation' | 'analysis' | 'triage';
export type KibanaApp = 'discover' | 'dashboards' | 'apm' | 'metrics' | 'alerts';

// ---------------------------------------------------------------------------------------------
// Shared pieces

export interface AnswerField {
  id: string;
  label: string;
  kind: 'string' | 'text' | 'statement' | 'number' | 'clock' | 'window';
  weight?: number;
  scored?: boolean;
  mentions?: string[];
  tolerance?: number;
  placeholder?: string;
  /** For a clock answer: the incident moment it names. */
  at?: string;
}

export interface AnswerSchema {
  type: 'diagnosis' | 'comparison' | 'triage_decision';
  fields: AnswerField[];
}

export interface ModePolicy {
  action_actor: 'learner' | 'tutorial';
  show_narration: boolean;
  highlight_target: boolean;
  validate_timing: 'immediate' | 'debrief';
  allow_demonstrate_step: boolean;
  allow_hints?: boolean;
}

export interface ScenarioSummary {
  id: string;
  title: string;
  type: ScenarioType;
  difficulty: number;
  estimated_minutes: number;
  skills: string[];
}

/** session_public: what the learner may know about the session. */
export interface SessionPublic {
  session_id: string;
  run_id: string;
  mode: Mode;
  policy: ModePolicy;
  brief: string;
  scenario: ScenarioSummary;
  answer_schema: AnswerSchema;
  investigation_url: string;
  completed_goals: string[];
  step: number;
  step_count: number;
}

/** learner_session: a challenge's replies carry no progress. */
export type LearnerSession = SessionPublic | Omit<SessionPublic, 'completed_goals' | 'step' | 'step_count'>;

export interface SessionConnection extends SessionPublic {
  connection_token: string;
  websocket_path: string;
}

export interface TimeWindow {
  from: string;
  to: string;
}

export interface EarnedFilter {
  field: string;
  value: string | number;
  negate: boolean;
}

/** What the guided coach puts back when the learner's search reaches a dead end. */
export interface RestoreState {
  baseline_time: TimeWindow | null;
  time: TimeWindow | null;
  filters: EarnedFilter[];
  query: string | null;
}

/** What a result card rings on the page (or the opening goal card, for goal_focus). */
export interface EvidenceFocus {
  kind: 'histogram' | 'query' | 'filter' | 'top_values' | 'document' | 'columns' | 'table_row' | 'request_line' | 'panel_filter'
    | 'entity' | 'inventory_outlier' | 'esql_row' | 'span_details' | 'alert_summary';
  field?: string;
  fields?: string[];
  value?: string | number;
  text?: string;
  metric?: string;
  open?: boolean;
  panels?: string[];
}

// ---------------------------------------------------------------------------------------------
// Server → coach WebSocket messages

export interface BriefingSource {
  key: string;
  label: string;
  detail: string;
  icon: string;
}

export interface IncidentBriefing {
  protocol_version: 2;
  message_type: 'incident_briefing';
  briefing_id: string;
  scenario_id: string;
  scenario_title: string;
  mode: Mode;
  duration_ms: number;
  detected_offset_minutes: number;
  noticed_at: string | null;
  /** `text` holds {time} and {ago}, which the coach fills in the learner's clock. */
  timed_facts: {text: string; at: string}[];
  source: BriefingSource;
  graphic: string;
  severity: string;
  owner: string;
  environment: string;
  headline: string;
  summary: string;
  impact: string;
  signals: {label: string; value: string}[];
}

export type AnswerCommandType = 'request_answer' | 'request_diagnosis';
export type StepCommandType =
  | 'set_time_range' | 'enter_kql' | 'add_filter' | 'add_column' | 'sort_column' | 'open_field_statistics' | 'inspect_field'
  | 'expand_document' | 'switch_query_language' | 'enter_esql' | 'inspect_panel' | 'interact_with_panel_value'
  | 'view_panel_underlying_data' | 'select_apm_service' | 'open_transaction_group' | 'select_trace_sample' | 'select_span'
  | 'navigate_to_correlated_logs' | 'select_inventory_type' | 'select_metric' | 'select_infrastructure_entity'
  | 'navigate_from_metrics_to_logs' | 'open_alert' | 'inspect_alert_reason' | 'navigate_from_alert_to_source';

export interface DemonstrationSummary {
  title: string;
  answer: {finding: string; scope: string; conclusion: string; evidence: string; first_seen?: string};
  checks: {title: string; detail: string}[];
}

/** A step's reference arguments, as the coach performs them (shape depends on the command type). */
export type CommandValue =
  | string
  | {
    field?: string; value?: string | number; operator?: string; direction?: 'asc' | 'desc'; from?: string; to?: string;
    language?: string; query?: string; panel?: string; service?: string; transaction?: string; span?: string; type?: string; metric?: string;
  };

interface CommandBase {
  protocol_version: 2;
  message_type: 'command';
  command_id: string;
  run_id: string;
  session_id: string;
  sequence: number;
  step_id: string;
  /** The step's heading as the learner reads it (step_id is internal). */
  step_title: string;
  step_index: number;
  step_count: number;
  target: string;
  expected_page: KibanaApp;
  narration: string;
  /** Demonstration only; "" in other modes. */
  reasoning: string;
  evidence: string;
  concept: string;
  learning_focus: string[];
  evidence_focus: EvidenceFocus | null;
  goal_focus: EvidenceFocus | null;
  answer_schema: AnswerSchema;
}

export interface DemonstrationStepCommand extends CommandBase {
  mode: 'demonstration';
  type: StepCommandType;
  value: CommandValue;
}

/** The demonstration's last step: show the summary (the answer step, rewritten by the service). */
export interface DemonstrationDebriefCommand extends CommandBase {
  mode: 'demonstration';
  type: 'show_debrief';
  value: DemonstrationSummary;
}

/** What "Show me" plays for a guided step. */
export interface Walkthrough {
  narration: string;
  reasoning: string;
  evidence: string;
  learning_focus: string[];
  evidence_focus: EvidenceFocus | null;
}

export interface GuidedStepCommand extends CommandBase {
  mode: 'guided';
  type: StepCommandType;
  value: CommandValue;
  walkthrough: Walkthrough;
  restore_state: RestoreState;
  /** Active seconds before the coach checks in; never under 45. */
  pace_seconds: number;
}

export interface GuidedAnswerCommand extends CommandBase {
  mode: 'guided';
  type: AnswerCommandType;
  value: CommandValue | null;
  restore_state: RestoreState;
}

/** A challenge sends only the answer form: nothing about the reference route. */
export interface ChallengeCommand extends CommandBase {
  mode: 'challenge';
  type: AnswerCommandType;
  value: CommandValue | null;
}

export type Command = DemonstrationStepCommand | DemonstrationDebriefCommand | GuidedStepCommand | GuidedAnswerCommand | ChallengeCommand;

interface EvaluationBase {
  goals_progressed: string[];
  meaningful: boolean;
}

export interface ProgressEvaluation extends EvaluationBase {
  outcome: 'accepted' | 'observed';
  reason: string;
}

export interface DriftEvaluation extends EvaluationBase {
  outcome: 'drift';
  goals_progressed: [];
  meaningful: false;
  step_id: string;
  note: string;
  reason: string;
}

/** A challenge's mid-run reply: recorded, nothing about which step it served. */
export interface RecordedEvaluation extends EvaluationBase {
  outcome: 'recorded';
  goals_progressed: [];
  meaningful: false;
}

interface DeadEndBase extends EvaluationBase {
  outcome: 'dead_end';
  goals_progressed: [];
  meaningful: false;
  step_id: string | null;
  reason: string;
}

export interface EmptyResultEvaluation extends DeadEndBase {
  reason_code: 'empty_result';
}

export interface LostEarnedStateEvaluation extends DeadEndBase {
  reason_code: 'lost_earned_state';
  lost: EarnedFilter[];
}

export interface WindowMissEvaluation extends DeadEndBase {
  reason_code: 'window_misses_incident' | 'window_excludes_incident' | 'window_slid_past_incident';
  from: string | null;
  relative: boolean;
  from_minutes: number | null;
  incident_offset_minutes: number | null;
  window_start_at: string | null;
  window_end_at: string | null;
  incident_reference: 'noticed' | 'rollout' | 'onset' | null;
  incident_reference_at: string | null;
  /** The guided card, in the learner's clock time (absent when the moment is unknown). */
  headline?: string;
  detail?: string;
  /** The challenge debrief's line. */
  note?: string;
  /** The fixed start the coach types back in (not on the scope step itself). */
  restore_time?: TimeWindow;
}

export type DeadEndEvaluation = EmptyResultEvaluation | LostEarnedStateEvaluation | WindowMissEvaluation;
export type Evaluation = ProgressEvaluation | DriftEvaluation | RecordedEvaluation | DeadEndEvaluation;

export interface WindowWatch {
  from: string;
  slides_at: string;
}

export interface ActionResult {
  message_type: 'action_result';
  evaluation: Evaluation;
  session: LearnerSession;
  action: {type: string; sequence: number};
  /** Sent with a time_range_changed result only: when a guided relative window slides, else null. */
  window_watch?: WindowWatch | null;
}

export interface Hint {
  message_type: 'hint';
  /** null when hints are off (a challenge). */
  step_id: string | null;
  /** 0 when there is no hint to give. */
  level: number;
  text: string;
}

export interface CheckIn {
  message_type: 'check_in';
  step_id: string;
  step_title: string;
  drift: string[];
}

export interface WindowSlid {
  message_type: 'window_slid';
  evaluation: WindowMissEvaluation;
}

export interface Complete {
  message_type: 'complete';
  session_id: string;
}

/** The run can't be investigated any more; the coach stops and offers the launcher. */
export interface Failed {
  message_type: 'failed';
  session_id: string;
  reason: 'failed' | 'aborted' | 'missing' | 'timeout';
  error: string;
  launcher_url: string;
}

/** A message the service couldn't act on; the session carries on. */
export interface ErrorMessage {
  message_type: 'error';
  error: string;
}

export interface Status {
  message_type: 'status';
  paused: boolean;
}

export interface Acknowledged {
  message_type: 'acknowledged';
  command_id: string | null;
}

export type ServerMessage =
  | IncidentBriefing | Command | ActionResult | Hint | CheckIn | WindowSlid | Complete | Failed | ErrorMessage | Status | Acknowledged;

export type ServerMessageType = ServerMessage['message_type'];
export type ServerMessageOf<K extends ServerMessageType> = Extract<ServerMessage, {message_type: K}>;

// ---------------------------------------------------------------------------------------------
// Coach → server WebSocket messages

export interface ObservedAction {
  protocol_version: 1 | 2;
  run_id: string;
  session_id: string;
  sequence: number;
  type: string;
  actor: 'learner' | 'tutorial';
  observed_at: string;
  details: Record<string, unknown>;
  state_before: Record<string, unknown>;
  state_after: Record<string, unknown>;
  step_clock?: {step_id: string; seconds_active: number};
  view?: Record<string, unknown>;
}

export type ClientMessage =
  | {message_type: 'action'; action: ObservedAction}
  | {message_type: 'hint'}
  | {message_type: 'check_in'; step_id: string}
  | {message_type: 'window_check'}
  | {message_type: 'recovery_shown'; step_id: string; reason_code: string; diagnosis: string | null}
  | {message_type: 'briefing_ack'; briefing_id: string}
  | {message_type: 'ack'; command_id: string; status: 'completed' | 'failed'; observed_state: Record<string, unknown>}
  | {message_type: 'pause'}
  | {message_type: 'resume'}
  | {message_type: 'heartbeat'};

// ---------------------------------------------------------------------------------------------
// REST bodies

export interface ValidatorReading {
  ready: boolean;
  value: number | string;
  minimum: number | null;
}

/** GET /api/runs/<id> (the controller's public run state, through the learning service). */
export interface RunPublic {
  run_id: string;
  space_id: string;
  state: RunState;
  seed: number;
  scenario_key: string | null;
  template_id: string;
  title: string;
  brief: string;
  scenario_type: ScenarioType;
  created_at: string;
  ready_at: string | null;
  completed_at: string | null;
  evidence: {completed: number; required: number; validators?: Record<string, ValidatorReading>};
  error: string | null;
  investigation_url: string;
}

/** POST /api/runs and POST /api/runs/<id>/reset. */
export interface CreateRunResponse {
  run: RunPublic;
  session: SessionConnection;
}

/** POST /api/sessions/<id>/actions. */
export interface ActionResponse {
  evaluation: Evaluation;
  session: LearnerSession;
}

/** GET /api/sessions/<id>. */
export interface SessionStatus {
  session: LearnerSession;
  run_state: RunState | 'MISSING' | null;
  available: boolean;
  feedback_available: boolean;
  launcher_url: string;
}

export interface GuidedStepFeedback {
  id: string;
  title: string;
  outcome: 'independent' | 'hinted' | 'told' | 'shown' | 'incomplete';
  detail?: string;
  seconds_active?: number;
}

export interface GuidedFeedback {
  scored: true;
  total: number;
  completion: number;
  summary: string;
  assistance: {hints: number; demonstrated_steps: number; hinted_steps: number; shown_steps: number; told_steps: number; independent_steps: number; step_count: number};
  steps: GuidedStepFeedback[];
}

export interface StepDetour {
  id: string;
  title: string;
  dead_ends: string[];
  notes: string[];
  drift: string[];
}

interface ScoredFeedbackBase {
  components: {task_correctness: number; evidence_quality: number; goal_coverage: number; relevance: number; efficiency: number; diagnosis_correctness: number; investigation_relevance: number};
  task_correct: boolean;
  diagnosis_correct: boolean;
  supported_parts: string[];
  answer_review: {id: string; label: string; submitted: string; expected: string; correct: boolean}[];
  assistance: {hints: number; demonstrated_steps: number; score_penalty: number};
  decisive_route: string[];
  detours: string[];
  step_detours: StepDetour[];
  reference_route: string[];
  reference_steps: string[];
  summary: string;
  replay: {same_seed: number; new_seed: null; modes: Mode[]};
}

export interface ChallengeFeedback extends ScoredFeedbackBase {
  scored: true;
  total: number;
}

export interface DemonstrationFeedback extends ScoredFeedbackBase {
  scored: false;
  total: null;
  /** So a reloaded tab can show the summary again. */
  demonstration_summary: DemonstrationSummary;
}

export type Feedback = GuidedFeedback | ChallengeFeedback | DemonstrationFeedback;

export interface ErrorResponse {
  error: string;
  launcher_url?: string;
}

// ---------------------------------------------------------------------------------------------
// The generated samples: one or more of every variant.

export interface ProtocolSamples {
  server_messages: {[K in ServerMessageType]: NonEmpty<ServerMessageOf<K>>};
  rest: {
    create_run: NonEmpty<CreateRunResponse>;
    run: NonEmpty<RunPublic>;
    action_response: NonEmpty<ActionResponse>;
    session_status: NonEmpty<SessionStatus>;
    feedback: {guided: NonEmpty<GuidedFeedback>; challenge: NonEmpty<ChallengeFeedback>; demonstration: NonEmpty<DemonstrationFeedback>};
    error: NonEmpty<ErrorResponse>;
  };
}
