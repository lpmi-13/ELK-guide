// The coach's other scripts, as the protocol check of content-script.js sees them (tsconfig.coach.json).
// They are plain browser scripts outside that check, so they are declared loosely here.
declare const IncidentCoachPanel: any;
declare const KibanaAdapter: any;
declare const KibanaActionObserver: any;
declare const QueryExplainer: any;
interface Window {
  __coachBootOverlay?: {hold(): void; release(): void};
}
