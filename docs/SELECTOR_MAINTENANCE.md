# Kibana selector maintenance

Selectors are pinned to Kibana 9.5.2 in both `learning/selectors/kibana-9.5.json` and `kibana-coach/selectors/kibana-9.5.json`; tests require byte-equivalent parsed content.

Prefer, in order, stable `data-test-subj` attributes, accessible roles and labels, application URLs, and public application state. Keep the strongest selector first and a small number of meaningful fallbacks after it. Do not use screen coordinates, panel positions, generated object IDs, or deep CSS hierarchy.

Each application adapter owns its semantic commands. When a selector changes, run the application-family adapter contract, then the complete scenario-mode matrix. Missing or ambiguous targets must surface the semantic target name in diagnostics. Verify keyboard focus and coach-panel placement at narrow and standard viewports.
