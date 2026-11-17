import {
  MessageSquare,
  Calendar,
  Users,
  Target,
  CreditCard,
  Megaphone,
  ClipboardCheck,
  FolderOpen,
  FolderKanban,
  BarChart3,
  Settings,
  FileText,
  Files,
  Building2,
  Palette,
  FileSignature,
  Landmark,
  CalendarClock,
  Activity,
  Brain,
  Bot,
  Factory,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import type { PermissionKey } from '../types';

export interface NavTab {
  name: string;
  path: string;
  icon: LucideIcon;
  permission: PermissionKey;
  featureFlag?: string;
}

export interface NavItem {
  name: string;
  path: string;
  icon: LucideIcon;
  permission: PermissionKey;
  featureFlag?: string;
  /**
   * Module made of tabs that keep their own URLs. The entry shows when any tab is accessible
   * (permission/featureFlag above are ignored) and stays active on every tab's path.
   */
  tabs?: NavTab[];
}

/** Settings → Organization: Staff Management and Brandboard live here as tabs (URLs unchanged). */
export const organizationTabs: NavTab[] = [
  { name: 'Organization', path: '/settings/organization', icon: Building2, permission: 'settings.manage' },
  { name: 'Staff Management', path: '/settings/staff', icon: Users, permission: 'users.view' },
  { name: 'Brandboard', path: '/settings/brandboard', icon: Palette, permission: 'brandboard.view', featureFlag: 'brandboard' },
];

export const documentsTabs: NavTab[] = [
  { name: 'Proposals', path: '/proposals', icon: FileText, permission: 'proposals.view', featureFlag: 'proposals' },
  { name: 'Contracts', path: '/contracts', icon: FileSignature, permission: 'contracts.view', featureFlag: 'contracts' },
];

export interface NavSection {
  id: string;
  title?: string;
  collapsible?: boolean;
  items: NavItem[];
}

export const navigationConfig: NavSection[] = [
  {
    id: 'core-operations',
    title: 'Core Operations',
    collapsible: true,
    items: [
      { name: 'Calendars', path: '/calendars', icon: Calendar, permission: 'calendars.view', featureFlag: 'calendars' },
      { name: 'Documents', path: '/documents', icon: Files, permission: 'proposals.view', tabs: documentsTabs },
      { name: 'Contacts', path: '/contacts', icon: Users, permission: 'contacts.view', featureFlag: 'contacts' },
      { name: 'Payments', path: '/payments', icon: CreditCard, permission: 'payments.view', featureFlag: 'payments' },
      { name: 'Projects', path: '/projects', icon: FolderKanban, permission: 'projects.view', featureFlag: 'projects' },
    ],
  },
  {
    id: 'growth-marketing',
    title: 'Growth & Marketing',
    collapsible: true,
    items: [
      { name: 'Conversations', path: '/conversations', icon: MessageSquare, permission: 'conversations.view', featureFlag: 'conversations' },
      { name: 'Opportunities', path: '/opportunities', icon: Target, permission: 'opportunities.view', featureFlag: 'opportunities' },
      { name: 'Government', path: '/government', icon: Landmark, permission: 'government.view', featureFlag: 'government' },
      { name: 'Marketing', path: '/marketing', icon: Megaphone, permission: 'marketing.view', featureFlag: 'marketing' },
    ],
  },
  {
    id: 'automation-ai',
    title: 'Automation & AI',
    collapsible: true,
    items: [
      // Owner decisions queued by the AI agents (and any legacy workflow approval steps).
      { name: 'Approvals', path: '/automation/approvals', icon: ClipboardCheck, permission: 'automation.view', featureFlag: 'automation' },
      // The autonomous AI staff (CLARA/FRIDAY) live under Agent Schedules below.
      { name: 'Agent Schedules', path: '/agent-tasks', icon: CalendarClock, permission: 'agent_tasks.view', featureFlag: 'agent_tasks' },
      { name: 'Agent Health', path: '/agent-health', icon: Activity, permission: 'agent_tasks.view', featureFlag: 'agent_tasks' },
      { name: 'HARVEY', path: '/harvey', icon: Bot, permission: 'harvey.view', featureFlag: 'harvey' },
      // Playbooks the agents run on deals / projects / schedules, plus the owner's autonomy decisions.
      { name: 'Factory', path: '/factory', icon: Factory, permission: 'factory.view', featureFlag: 'factory' },
      // Fractional CAIO delivery: registers, documents and gates per client engagement.
      { name: 'CAIO', path: '/caio', icon: ShieldCheck, permission: 'caio.view', featureFlag: 'caio' },
      { name: 'Memory', path: '/memory', icon: Brain, permission: 'memory.view', featureFlag: 'memory' },
    ],
  },
  {
    id: 'files-analytics',
    title: 'Files & Analytics',
    collapsible: true,
    items: [
      { name: 'File Manager', path: '/media', icon: FolderOpen, permission: 'media.view', featureFlag: 'media' },
      { name: 'Reporting', path: '/reporting', icon: BarChart3, permission: 'reporting.view', featureFlag: 'reporting' },
    ],
  },
  {
    id: 'administration',
    title: 'Administration',
    collapsible: true,
    items: [
      { name: 'Settings', path: '/settings', icon: Settings, permission: 'settings.view' },
    ],
  },
];
