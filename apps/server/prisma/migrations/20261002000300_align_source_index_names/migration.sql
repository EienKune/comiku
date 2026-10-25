-- Earlier source migrations used shortened index names; the schema now maps
-- canonical names. Rename only legacy indexes so fresh and upgraded databases agree.
DO $$
BEGIN
  IF to_regclass('candidate_classification_suggestions_candidate_post_id_crea_idx') IS NOT NULL AND to_regclass('candidate_classification_suggestions_candidate_post_id_created_') IS NULL THEN
    ALTER INDEX "candidate_classification_suggestions_candidate_post_id_crea_idx" RENAME TO "candidate_classification_suggestions_candidate_post_id_created_";
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('candidate_source_observations_adapter_state_id_last_observe_idx') IS NOT NULL AND to_regclass('candidate_source_observations_adapter_state_id_last_observed_at') IS NULL THEN
    ALTER INDEX "candidate_source_observations_adapter_state_id_last_observe_idx" RENAME TO "candidate_source_observations_adapter_state_id_last_observed_at";
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('candidate_source_observations_external_account_id_last_obse_idx') IS NOT NULL AND to_regclass('candidate_source_observations_external_account_id_last_observed') IS NULL THEN
    ALTER INDEX "candidate_source_observations_external_account_id_last_obse_idx" RENAME TO "candidate_source_observations_external_account_id_last_observed";
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('source_adapter_states_adapter_key_enabled_health_next_attem_idx') IS NOT NULL AND to_regclass('source_adapter_states_adapter_key_enabled_health_next_attempt_a') IS NULL THEN
    ALTER INDEX "source_adapter_states_adapter_key_enabled_health_next_attem_idx" RENAME TO "source_adapter_states_adapter_key_enabled_health_next_attempt_a";
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('source_fetch_run_items_run_id_external_account_id_adapter_k_key') IS NOT NULL AND to_regclass('source_fetch_run_items_run_id_external_account_id_adapter_key_k') IS NULL THEN
    ALTER INDEX "source_fetch_run_items_run_id_external_account_id_adapter_k_key" RENAME TO "source_fetch_run_items_run_id_external_account_id_adapter_key_k";
  END IF;
END $$;
