export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      access_activations: {
        Row: {
          client_token_hash: string
          created_at: string
          id: string
          last_seen_at: string
          revoked_at: string | null
          secret_id: string
          user_id: string
        }
        Insert: {
          client_token_hash: string
          created_at?: string
          id?: string
          last_seen_at?: string
          revoked_at?: string | null
          secret_id: string
          user_id: string
        }
        Update: {
          client_token_hash?: string
          created_at?: string
          id?: string
          last_seen_at?: string
          revoked_at?: string | null
          secret_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "access_activations_secret_id_fkey"
            columns: ["secret_id"]
            isOneToOne: false
            referencedRelation: "user_access_secrets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "access_activations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      access_requests: {
        Row: {
          created_at: string
          email_normalized: string
          full_name: string
          id: string
          phone_e164: string
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          email_normalized: string
          full_name: string
          id?: string
          phone_e164: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          email_normalized?: string
          full_name?: string
          id?: string
          phone_e164?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "access_requests_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "access_requests_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      access_security_events: {
        Row: {
          actor_user_id: string | null
          created_at: string
          event_type: string
          id: number
          metadata: Json
          request_id: string | null
          secret_id: string | null
          user_id: string | null
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          event_type: string
          id?: never
          metadata?: Json
          request_id?: string | null
          secret_id?: string | null
          user_id?: string | null
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          event_type?: string
          id?: never
          metadata?: Json
          request_id?: string | null
          secret_id?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "access_security_events_actor_user_id_fkey"
            columns: ["actor_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "access_security_events_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "access_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "access_security_events_secret_id_fkey"
            columns: ["secret_id"]
            isOneToOne: false
            referencedRelation: "user_access_secrets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "access_security_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      audio_assets: {
        Row: {
          created_at: string
          duration_sec: number | null
          file_size_bytes: number | null
          filename: string
          id: string
          mime_type: string | null
          project_id: string
          storage_path: string
        }
        Insert: {
          created_at?: string
          duration_sec?: number | null
          file_size_bytes?: number | null
          filename: string
          id?: string
          mime_type?: string | null
          project_id: string
          storage_path: string
        }
        Update: {
          created_at?: string
          duration_sec?: number | null
          file_size_bytes?: number | null
          filename?: string
          id?: string
          mime_type?: string | null
          project_id?: string
          storage_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "audio_assets_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      clip_candidates: {
        Row: {
          created_at: string
          duration_sec: number | null
          fallback_urls: Json
          height: number | null
          id: string
          provider: string
          provider_clip_id: string
          scene_id: string
          score: number | null
          thumbnail_url: string | null
          url: string
          width: number | null
        }
        Insert: {
          created_at?: string
          duration_sec?: number | null
          fallback_urls?: Json
          height?: number | null
          id?: string
          provider: string
          provider_clip_id: string
          scene_id: string
          score?: number | null
          thumbnail_url?: string | null
          url: string
          width?: number | null
        }
        Update: {
          created_at?: string
          duration_sec?: number | null
          fallback_urls?: Json
          height?: number | null
          id?: string
          provider?: string
          provider_clip_id?: string
          scene_id?: string
          score?: number | null
          thumbnail_url?: string | null
          url?: string
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "clip_candidates_scene_id_fkey"
            columns: ["scene_id"]
            isOneToOne: false
            referencedRelation: "scenes"
            referencedColumns: ["id"]
          },
        ]
      }
      pexels_api_keys: {
        Row: {
          added_at: string
          api_key: string
          id: string
          is_active: boolean
          last_error: string | null
          last_error_at: string | null
          last_used_at: string | null
          rate_limit_remaining: number | null
          rate_limit_reset_at: string | null
          request_count: number
        }
        Insert: {
          added_at?: string
          api_key: string
          id?: string
          is_active?: boolean
          last_error?: string | null
          last_error_at?: string | null
          last_used_at?: string | null
          rate_limit_remaining?: number | null
          rate_limit_reset_at?: string | null
          request_count?: number
        }
        Update: {
          added_at?: string
          api_key?: string
          id?: string
          is_active?: boolean
          last_error?: string | null
          last_error_at?: string | null
          last_used_at?: string | null
          rate_limit_remaining?: number | null
          rate_limit_reset_at?: string | null
          request_count?: number
        }
        Relationships: []
      }
      nasa_asset_cache: {
        Row: {
          cached_at: string
          duration_known: boolean
          duration_seconds: number | null
          files: Json
          has_captions: boolean | null
          nasa_id: string
          thumbnail_url: string | null
        }
        Insert: {
          cached_at?: string
          duration_known?: boolean
          duration_seconds?: number | null
          files?: Json
          has_captions?: boolean | null
          nasa_id: string
          thumbnail_url?: string | null
        }
        Update: {
          cached_at?: string
          duration_known?: boolean
          duration_seconds?: number | null
          files?: Json
          has_captions?: boolean | null
          nasa_id?: string
          thumbnail_url?: string | null
        }
        Relationships: []
      }
      project_cleanup_audit: {
        Row: {
          active_render_cancelled: boolean
          bytes_freed: number
          cancelled_render_job_ids: string[]
          created_at: string
          deleted_at: string
          file_count_removed: number
          id: number
          project_created_at: string | null
          project_id: string
          project_name: string | null
          project_status: string | null
        }
        Insert: {
          active_render_cancelled?: boolean
          bytes_freed?: number
          cancelled_render_job_ids?: string[]
          created_at?: string
          deleted_at?: string
          file_count_removed?: number
          id?: number
          project_created_at?: string | null
          project_id: string
          project_name?: string | null
          project_status?: string | null
        }
        Update: {
          active_render_cancelled?: boolean
          bytes_freed?: number
          cancelled_render_job_ids?: string[]
          created_at?: string
          deleted_at?: string
          file_count_removed?: number
          id?: number
          project_created_at?: string | null
          project_id?: string
          project_name?: string | null
          project_status?: string | null
        }
        Relationships: []
      }
      project_stock_corpus: {
        Row: {
          bucket_id: string
          candidates: Json
          created_at: string
          demand_ids: Json
          project_id: string
          providers_done: Json
          query: string
          tokens: Json
          updated_at: string
        }
        Insert: {
          bucket_id: string
          candidates?: Json
          created_at?: string
          demand_ids?: Json
          project_id: string
          providers_done?: Json
          query: string
          tokens?: Json
          updated_at?: string
        }
        Update: {
          bucket_id?: string
          candidates?: Json
          created_at?: string
          demand_ids?: Json
          project_id?: string
          providers_done?: Json
          query?: string
          tokens?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_stock_corpus_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          aspect_ratio: string
          category: string | null
          clip_duration_seconds: number | null
          created_at: string
          error_message: string | null
          id: string
          matching_lock_at: string | null
          name: string
          niche: string
          pipeline_cancel_requested_at: string | null
          provider_job_id: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          aspect_ratio?: string
          category?: string | null
          clip_duration_seconds?: number | null
          created_at?: string
          error_message?: string | null
          id?: string
          matching_lock_at?: string | null
          name?: string
          niche?: string
          pipeline_cancel_requested_at?: string | null
          provider_job_id?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          aspect_ratio?: string
          category?: string | null
          clip_duration_seconds?: number | null
          created_at?: string
          error_message?: string | null
          id?: string
          matching_lock_at?: string | null
          name?: string
          niche?: string
          pipeline_cancel_requested_at?: string | null
          provider_job_id?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "projects_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      provider_usage: {
        Row: {
          cache_hit_count: number
          id: string
          provider: string
          request_count: number
          updated_at: string
          usage_date: string
        }
        Insert: {
          cache_hit_count?: number
          id?: string
          provider: string
          request_count?: number
          updated_at?: string
          usage_date?: string
        }
        Update: {
          cache_hit_count?: number
          id?: string
          provider?: string
          request_count?: number
          updated_at?: string
          usage_date?: string
        }
        Relationships: []
      }
      render_clip_slices: {
        Row: {
          clip_url: string
          created_at: string
          duration_seconds: number
          fallback_urls: Json
          id: string
          in_point_seconds: number
          project_id: string
          provider: string
          provider_clip_id: string | null
          scene_id: string
          slice_index: number
          thumbnail_url: string | null
          timeline_end_seconds: number
          timeline_start_seconds: number
        }
        Insert: {
          clip_url: string
          created_at?: string
          duration_seconds: number
          fallback_urls?: Json
          id?: string
          in_point_seconds?: number
          project_id: string
          provider?: string
          provider_clip_id?: string | null
          scene_id: string
          slice_index: number
          thumbnail_url?: string | null
          timeline_end_seconds: number
          timeline_start_seconds: number
        }
        Update: {
          clip_url?: string
          created_at?: string
          duration_seconds?: number
          fallback_urls?: Json
          id?: string
          in_point_seconds?: number
          project_id?: string
          provider?: string
          provider_clip_id?: string | null
          scene_id?: string
          slice_index?: number
          thumbnail_url?: string | null
          timeline_end_seconds?: number
          timeline_start_seconds?: number
        }
        Relationships: [
          {
            foreignKeyName: "render_clip_slices_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "render_clip_slices_scene_id_fkey"
            columns: ["scene_id"]
            isOneToOne: false
            referencedRelation: "scenes"
            referencedColumns: ["id"]
          },
        ]
      }
      render_jobs: {
        Row: {
          chunks_completed: number | null
          chunks_total: number | null
          completed_at: string | null
          created_at: string
          error: string | null
          id: string
          output_url: string | null
          progress_pct: number
          project_id: string
          settings: Json
          stall_notice: string | null
          started_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          chunks_completed?: number | null
          chunks_total?: number | null
          completed_at?: string | null
          created_at?: string
          error?: string | null
          id?: string
          output_url?: string | null
          progress_pct?: number
          project_id: string
          settings: Json
          stall_notice?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          chunks_completed?: number | null
          chunks_total?: number | null
          completed_at?: string | null
          created_at?: string
          error?: string | null
          id?: string
          output_url?: string | null
          progress_pct?: number
          project_id?: string
          settings?: Json
          stall_notice?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "render_jobs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      scenes: {
        Row: {
          created_at: string
          end_ts: number
          id: string
          idx: number
          project_id: string
          start_ts: number
          status: string
          text: string
          transcript_id: string
          visual_query: string | null
        }
        Insert: {
          created_at?: string
          end_ts: number
          id?: string
          idx: number
          project_id: string
          start_ts: number
          status?: string
          text: string
          transcript_id: string
          visual_query?: string | null
        }
        Update: {
          created_at?: string
          end_ts?: number
          id?: string
          idx?: number
          project_id?: string
          start_ts?: number
          status?: string
          text?: string
          transcript_id?: string
          visual_query?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "scenes_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scenes_transcript_id_fkey"
            columns: ["transcript_id"]
            isOneToOne: false
            referencedRelation: "transcripts"
            referencedColumns: ["id"]
          },
        ]
      }
      selected_clips: {
        Row: {
          clip_candidate_id: string
          created_at: string
          id: string
          in_point: number
          out_point: number
          scene_id: string
        }
        Insert: {
          clip_candidate_id: string
          created_at?: string
          id?: string
          in_point?: number
          out_point: number
          scene_id: string
        }
        Update: {
          clip_candidate_id?: string
          created_at?: string
          id?: string
          in_point?: number
          out_point?: number
          scene_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "selected_clips_clip_candidate_id_fkey"
            columns: ["clip_candidate_id"]
            isOneToOne: false
            referencedRelation: "clip_candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "selected_clips_scene_id_fkey"
            columns: ["scene_id"]
            isOneToOne: true
            referencedRelation: "scenes"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_search_cache: {
        Row: {
          cached_at: string
          id: string
          orientation: string
          provider: string
          query: string
          results: Json
        }
        Insert: {
          cached_at?: string
          id?: string
          orientation: string
          provider: string
          query: string
          results: Json
        }
        Update: {
          cached_at?: string
          id?: string
          orientation?: string
          provider?: string
          query?: string
          results?: Json
        }
        Relationships: []
      }
      transcripts: {
        Row: {
          audio_asset_id: string | null
          created_at: string
          full_text: string
          id: string
          language: string | null
          project_id: string
          provider: string
          word_timestamps: Json | null
        }
        Insert: {
          audio_asset_id?: string | null
          created_at?: string
          full_text: string
          id?: string
          language?: string | null
          project_id: string
          provider: string
          word_timestamps?: Json | null
        }
        Update: {
          audio_asset_id?: string | null
          created_at?: string
          full_text?: string
          id?: string
          language?: string | null
          project_id?: string
          provider?: string
          word_timestamps?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "transcripts_audio_asset_id_fkey"
            columns: ["audio_asset_id"]
            isOneToOne: false
            referencedRelation: "audio_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transcripts_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      user_access_secrets: {
        Row: {
          activation_count: number
          created_at: string
          created_by: string | null
          failed_attempt_count: number
          failed_window_started_at: string | null
          id: string
          last_used_at: string | null
          max_activations: number
          revocation_reason: string | null
          revoked_at: string | null
          revoked_by: string | null
          secret_hash: string
          secret_suffix: string
          status: string
          user_id: string
        }
        Insert: {
          activation_count?: number
          created_at?: string
          created_by?: string | null
          failed_attempt_count?: number
          failed_window_started_at?: string | null
          id?: string
          last_used_at?: string | null
          max_activations?: number
          revocation_reason?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          secret_hash: string
          secret_suffix: string
          status?: string
          user_id: string
        }
        Update: {
          activation_count?: number
          created_at?: string
          created_by?: string | null
          failed_attempt_count?: number
          failed_window_started_at?: string | null
          id?: string
          last_used_at?: string | null
          max_activations?: number
          revocation_reason?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          secret_hash?: string
          secret_suffix?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_access_secrets_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_access_secrets_revoked_by_fkey"
            columns: ["revoked_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_access_secrets_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          approval_status: string
          created_at: string
          email: string
          full_name: string | null
          id: string
          is_primary_admin: boolean
          phone_e164: string | null
          plan_tier: string
          role: string
        }
        Insert: {
          approval_status?: string
          created_at?: string
          email: string
          full_name?: string | null
          id: string
          is_primary_admin?: boolean
          phone_e164?: string | null
          plan_tier?: string
          role?: string
        }
        Update: {
          approval_status?: string
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          is_primary_admin?: boolean
          phone_e164?: string | null
          plan_tier?: string
          role?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      activate_access_secret: {
        Args: {
          p_client_token_hash: string
          p_secret_hash: string
          p_user_id: string
        }
        Returns: {
          activation_count: number
          max_activations: number
          outcome: string
        }[]
      }
      check_access_activation: {
        Args: { p_client_token_hash: string; p_user_id: string }
        Returns: boolean
      }
      cleanup_delete_project_with_audit: {
        Args: {
          p_active_render_cancelled: boolean
          p_bytes_freed: number
          p_cancelled_render_job_ids: string[]
          p_file_count_removed: number
          p_project_created_at: string
          p_project_id: string
          p_project_name: string
          p_project_status: string
        }
        Returns: undefined
      }
      has_platform_account_access: { Args: never; Returns: boolean }
      increment_pexels_key_usage: { Args: { p_id: string }; Returns: undefined }
      increment_provider_usage: {
        Args: { p_cache_hit: boolean; p_date: string; p_provider: string }
        Returns: undefined
      }
      increment_provider_usage_counts: {
        Args: {
          p_cache_hit_count: number
          p_date: string
          p_provider: string
          p_request_count: number
        }
        Returns: undefined
      }
      is_admin: { Args: { _user_id: string }; Returns: boolean }
      record_pexels_key_response: {
        Args: {
          p_id: string
          p_remaining: number | null
          p_reset_at: string | null
        }
        Returns: undefined
      }
      reset_access_secret_activations: {
        Args: { p_actor_user_id: string; p_secret_id: string }
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
