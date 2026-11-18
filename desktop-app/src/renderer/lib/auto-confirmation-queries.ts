import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from './api';
import { useAuth } from './auth';
import { getAutoConfirmation, saveAutoConfirmation } from './auto-confirmation-service';

export function useAutoConfirmation() {
  const { user } = useAuth();
  const client = useQueryClient();
  const key = ['auto-confirmation', API_BASE, user?.id];
  const query = useQuery({
    queryKey: key,
    queryFn: getAutoConfirmation,
    enabled: Boolean(user),
    staleTime: 60000,
  });
  const save = useMutation({
    mutationFn: saveAutoConfirmation,
    onSuccess: (data) => client.setQueryData(key, data),
    onError: () => {
      void client.invalidateQueries({ queryKey: key });
    },
  });
  return { query, save };
}
