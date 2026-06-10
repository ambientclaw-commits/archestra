"use client";

import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "./utils";

const { getLlmRouters, createLlmRouter, updateLlmRouter, deleteLlmRouter } =
  archestraApiSdk;

export type LlmRouter = archestraApiTypes.CreateLlmRouterResponses["200"];

export type CreateLlmRouterInput =
  archestraApiTypes.CreateLlmRouterData["body"];

export type UpdateLlmRouterInput = Partial<
  archestraApiTypes.UpdateLlmRouterData["body"]
> &
  archestraApiTypes.UpdateLlmRouterData["path"];

export function useLlmRouters() {
  return useQuery<LlmRouter[]>({
    queryKey: ["llm-routers"],
    queryFn: async () => {
      const response = await getLlmRouters();
      if (response.error) {
        handleApiError(response.error);
      }
      return response.data ?? [];
    },
  });
}

export function useCreateLlmRouter() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateLlmRouterInput) => {
      const { data: responseData, error } = await createLlmRouter({
        body: data,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return responseData;
    },
    onSuccess: async (data) => {
      if (!data) return;
      toast.success("Smart router created");
      await queryClient.invalidateQueries({ queryKey: ["llm-routers"] });
    },
  });
}

export function useUpdateLlmRouter() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: UpdateLlmRouterInput) => {
      const { id, ...updates } = data;
      const { data: responseData, error } = await updateLlmRouter({
        path: { id },
        body: updates,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return responseData;
    },
    onSuccess: async (data) => {
      if (!data) return;
      toast.success("Smart router updated");
      await queryClient.invalidateQueries({ queryKey: ["llm-routers"] });
    },
  });
}

export function useDeleteLlmRouter() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await deleteLlmRouter({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return { success: true };
    },
    onSuccess: async (data) => {
      if (!data) return;
      toast.success("Smart router deleted");
      await queryClient.invalidateQueries({ queryKey: ["llm-routers"] });
    },
  });
}
