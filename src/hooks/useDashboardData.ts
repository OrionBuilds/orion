import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import {
  getDashboardStats,
  getMyRecentConversations,
  getUserTasksDue,
  getFlaggedEmails,
  getMyUpcomingAppointments,
  getSystemHealthStatus,
  type DashboardStats,
  type AssignedConversation,
  type TaskDue,
  type FlaggedEmail,
  type DashboardAppointment,
  type SystemHealthStatus,
  type DateRange,
} from '../services/dashboard';

interface DashboardData {
  stats: DashboardStats | null;
  conversations: AssignedConversation[];
  tasks: TaskDue[];
  followUps: FlaggedEmail[];
  appointments: DashboardAppointment[];
  googleConnected: boolean;
  systemHealth: SystemHealthStatus;
}

interface LoadingState {
  stats: boolean;
  conversations: boolean;
  tasks: boolean;
  followUps: boolean;
  appointments: boolean;
  systemHealth: boolean;
}

interface ErrorState {
  stats: Error | null;
  conversations: Error | null;
  tasks: Error | null;
  followUps: Error | null;
  appointments: Error | null;
  systemHealth: Error | null;
}

export function useDashboardData(dateRange?: DateRange) {
  const { user } = useAuth();
  const [data, setData] = useState<DashboardData>({
    stats: null,
    conversations: [],
    tasks: [],
    followUps: [],
    appointments: [],
    googleConnected: false,
    systemHealth: { messaging: 'disconnected', calendar: 'disconnected', payments: 'disconnected' },
  });
  const [loading, setLoading] = useState<LoadingState>({
    stats: true,
    conversations: true,
    tasks: true,
    followUps: true,
    appointments: true,
    systemHealth: true,
  });
  const [errors, setErrors] = useState<ErrorState>({
    stats: null,
    conversations: null,
    tasks: null,
    followUps: null,
    appointments: null,
    systemHealth: null,
  });

  const organizationId = user?.organization_id;
  const userId = user?.id;

  const fetchStats = useCallback(async () => {
    if (!organizationId || !userId) return;
    setLoading((prev) => ({ ...prev, stats: true }));
    const { data: stats, error } = await getDashboardStats(organizationId, userId, dateRange);
    setData((prev) => ({ ...prev, stats }));
    setErrors((prev) => ({ ...prev, stats: error }));
    setLoading((prev) => ({ ...prev, stats: false }));
  }, [organizationId, userId, dateRange]);

  const fetchConversations = useCallback(async () => {
    if (!userId || !organizationId) return;
    setLoading((prev) => ({ ...prev, conversations: true }));
    const { data: conversations, error } = await getMyRecentConversations(userId, organizationId);
    setData((prev) => ({ ...prev, conversations }));
    setErrors((prev) => ({ ...prev, conversations: error }));
    setLoading((prev) => ({ ...prev, conversations: false }));
  }, [userId, organizationId]);

  const fetchTasks = useCallback(async () => {
    if (!userId || !organizationId) return;
    setLoading((prev) => ({ ...prev, tasks: true }));
    const { data: tasks, error } = await getUserTasksDue(userId, organizationId);
    setData((prev) => ({ ...prev, tasks }));
    setErrors((prev) => ({ ...prev, tasks: error }));
    setLoading((prev) => ({ ...prev, tasks: false }));
  }, [userId, organizationId]);

  const fetchFollowUps = useCallback(async () => {
    if (!userId) return;
    setLoading((prev) => ({ ...prev, followUps: true }));
    const { data: followUps, error } = await getFlaggedEmails(userId);
    setData((prev) => ({ ...prev, followUps }));
    setErrors((prev) => ({ ...prev, followUps: error }));
    setLoading((prev) => ({ ...prev, followUps: false }));
  }, [userId]);

  const fetchAppointments = useCallback(async () => {
    if (!userId || !organizationId) return;
    setLoading((prev) => ({ ...prev, appointments: true }));
    const { data: appointments, googleConnected, error } = await getMyUpcomingAppointments(
      userId,
      organizationId
    );
    setData((prev) => ({ ...prev, appointments, googleConnected }));
    setErrors((prev) => ({ ...prev, appointments: error }));
    setLoading((prev) => ({ ...prev, appointments: false }));
  }, [userId, organizationId]);

  const fetchSystemHealth = useCallback(async () => {
    if (!organizationId) return;
    setLoading((prev) => ({ ...prev, systemHealth: true }));
    const { data: systemHealth, error } = await getSystemHealthStatus(organizationId);
    setData((prev) => ({ ...prev, systemHealth }));
    setErrors((prev) => ({ ...prev, systemHealth: error }));
    setLoading((prev) => ({ ...prev, systemHealth: false }));
  }, [organizationId]);

  const refetch = useCallback(() => {
    fetchStats();
    fetchConversations();
    fetchTasks();
    fetchFollowUps();
    fetchAppointments();
    fetchSystemHealth();
  }, [fetchStats, fetchConversations, fetchTasks, fetchFollowUps, fetchAppointments, fetchSystemHealth]);

  useEffect(() => {
    if (organizationId && userId) {
      refetch();
    }
  }, [organizationId, userId]);

  const isLoading = Object.values(loading).some(Boolean);

  return {
    ...data,
    loading,
    errors,
    isLoading,
    refetch,
    refetchStats: fetchStats,
    refetchConversations: fetchConversations,
    refetchTasks: fetchTasks,
    refetchFollowUps: fetchFollowUps,
    refetchAppointments: fetchAppointments,
  };
}
