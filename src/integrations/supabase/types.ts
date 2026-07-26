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
      projects: {
        Row: {
          aspect_ratio: string
          category: string | null
          clip_duration_seconds: number | null
          created_at: string
          error_message: string | null
          id: string
          name: string
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
          name?: string
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
          name?: string
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
          id: string
          project_id: string
          scene_id: string
          slice_index: number
          clip_url: string
          provider_clip_id: string | null
          duration_seconds: number
          created_at: string
        }
        Insert: {
          id?: string
          project_id: string
          scene_id: string
          slice_index: number
          clip_url: string
          provider_clip_id?: string | null
          duration_seconds: number
          created_at?: string
        }
        Update: {
          id?: string
          project_id?: string
          scene_id?: string
          slice_index?: number
          clip_url?: string
          provider_clip_id?: string | null
          duration_seconds?: number
          created_at?: string
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
      users: {
        Row: {
          created_at: string
          email: string
          id: string
          plan_tier: string
        }
        Insert: {
          created_at?: string
          email: string
          id: string
          plan_tier?: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          plan_tier?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      increment_provider_usage: {
        Args: { p_cache_hit: boolean; p_date: string; p_provider: string }
        Returns: undefined
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
