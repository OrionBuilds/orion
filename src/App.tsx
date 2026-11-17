import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { SidebarProvider } from './contexts/SidebarContext';
import { DeviceProvider } from './contexts/DeviceContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { ToastProvider } from './contexts/ToastContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { StartPageRedirect } from './components/StartPageRedirect';
import { PaymentsGate } from './components/PaymentsGate';
import { PageLoader } from './components/shared/PageLoader';
import { FirstAccessibleTab } from './components/layouts';
import { documentsTabs } from './config/navigation';
import { DashboardLayout } from './layouts/DashboardLayout';
import { Login } from './pages/Login';
import { AccessDenied } from './pages/auth/AccessDenied';
import { ForgotPassword } from './pages/ForgotPassword';
import { Dashboard } from './pages/Dashboard';
import { Unauthorized } from './pages/Unauthorized';
import { FeatureDisabled } from './pages/FeatureDisabled';
import { NotFound } from './pages/NotFound';

// Lazy-loaded page components for code splitting
const Profile = lazy(() => import('./pages/Profile').then(m => ({ default: m.Profile })));
const Conversations = lazy(() => import('./pages/modules/Conversations').then(m => ({ default: m.Conversations })));
const ClaraPage = lazy(() => import('./pages/modules/ClaraPage').then(m => ({ default: m.ClaraPage })));
const Calendars = lazy(() => import('./pages/modules/Calendars').then(m => ({ default: m.Calendars })));
const AgentTasks = lazy(() => import('./pages/modules/AgentTasks').then(m => ({ default: m.AgentTasks })));
const AgentHealth = lazy(() => import('./pages/modules/AgentHealth').then(m => ({ default: m.AgentHealth })));
const Harvey = lazy(() => import('./pages/modules/Harvey').then(m => ({ default: m.Harvey })));
const Factory = lazy(() => import('./pages/modules/Factory').then(m => ({ default: m.Factory })));
const Caio = lazy(() => import('./pages/modules/Caio').then(m => ({ default: m.Caio })));
const Memory = lazy(() => import('./pages/modules/Memory').then(m => ({ default: m.Memory })));
const CalendarDetail = lazy(() => import('./pages/modules/CalendarDetail').then(m => ({ default: m.CalendarDetail })));
const Contacts = lazy(() => import('./pages/modules/Contacts').then(m => ({ default: m.Contacts })));
const ContactDetail = lazy(() => import('./pages/modules/ContactDetail').then(m => ({ default: m.ContactDetail })));
const Opportunities = lazy(() => import('./pages/modules/Opportunities').then(m => ({ default: m.Opportunities })));
const OpportunitiesListPage = lazy(() => import('./pages/modules/OpportunitiesListPage').then(m => ({ default: m.OpportunitiesListPage })));
const OpportunityDetail = lazy(() => import('./pages/modules/OpportunityDetail').then(m => ({ default: m.OpportunityDetail })));
const PipelinesPage = lazy(() => import('./pages/modules/PipelinesPage').then(m => ({ default: m.PipelinesPage })));
const OpportunitiesLayout = lazy(() => import('./layouts/OpportunitiesLayout').then(m => ({ default: m.OpportunitiesLayout })));
const GovContractSearch = lazy(() => import('./pages/modules/GovContractSearch'));
const DocumentsLayout = lazy(() => import('./layouts/DocumentsLayout').then(m => ({ default: m.DocumentsLayout })));
const ProjectsLayout = lazy(() => import('./layouts/ProjectsLayout').then(m => ({ default: m.ProjectsLayout })));
const Projects = lazy(() => import('./pages/modules/Projects').then(m => ({ default: m.Projects })));
const ProjectsListPage = lazy(() => import('./pages/modules/ProjectsListPage').then(m => ({ default: m.ProjectsListPage })));
const ProjectPipelinesPage = lazy(() => import('./pages/modules/ProjectPipelinesPage').then(m => ({ default: m.ProjectPipelinesPage })));
const ProjectProfitabilityPage = lazy(() => import('./pages/modules/ProjectProfitabilityPage').then(m => ({ default: m.ProjectProfitabilityPage })));
const ProjectDetail = lazy(() => import('./pages/modules/ProjectDetail').then(m => ({ default: m.ProjectDetail })));
const Payments = lazy(() => import('./pages/modules/Payments').then(m => ({ default: m.Payments })));
const InvoiceDetail = lazy(() => import('./pages/modules/InvoiceDetail').then(m => ({ default: m.InvoiceDetail })));
const Proposals = lazy(() => import('./pages/modules/Proposals').then(m => ({ default: m.Proposals })));
const ProposalDetail = lazy(() => import('./pages/modules/ProposalDetail').then(m => ({ default: m.ProposalDetail })));
const ProposalBuilder = lazy(() => import('./pages/modules/ProposalBuilder').then(m => ({ default: m.ProposalBuilder })));
const Marketing = lazy(() => import('./pages/modules/Marketing').then(m => ({ default: m.Marketing })));
const MarketingForms = lazy(() => import('./pages/modules/MarketingForms').then(m => ({ default: m.MarketingForms })));
const FormBuilder = lazy(() => import('./pages/modules/FormBuilder').then(m => ({ default: m.FormBuilder })));
const FormSubmissions = lazy(() => import('./pages/modules/FormSubmissions').then(m => ({ default: m.FormSubmissions })));
const MarketingSurveys = lazy(() => import('./pages/modules/MarketingSurveys').then(m => ({ default: m.MarketingSurveys })));
const SurveyBuilder = lazy(() => import('./pages/modules/SurveyBuilder').then(m => ({ default: m.SurveyBuilder })));
const SurveySubmissions = lazy(() => import('./pages/modules/SurveySubmissions').then(m => ({ default: m.SurveySubmissions })));
const EmailTemplates = lazy(() => import('./pages/modules/EmailTemplates'));
const EmailTemplateEditor = lazy(() => import('./pages/modules/EmailTemplateEditor'));
const AutomationApprovals = lazy(() => import('./pages/modules/AutomationApprovals'));
const MediaStorage = lazy(() => import('./pages/modules/MediaStorage').then(m => ({ default: m.MediaStorage })));
const Reporting = lazy(() => import('./pages/modules/Reporting').then(m => ({ default: m.Reporting })));
const ReportView = lazy(() => import('./pages/modules/ReportView').then(m => ({ default: m.ReportView })));
const OrganizationSettingsLayout = lazy(() => import('./layouts/OrganizationSettingsLayout').then(m => ({ default: m.OrganizationSettingsLayout })));
const SettingsLayout = lazy(() => import('./layouts/SettingsLayout').then(m => ({ default: m.SettingsLayout })));
const MyProfilePage = lazy(() => import('./pages/settings/MyProfilePage').then(m => ({ default: m.MyProfilePage })));
const MyStaffPage = lazy(() => import('./pages/settings/MyStaffPage').then(m => ({ default: m.MyStaffPage })));
const OrganizationSettingsPage = lazy(() => import('./pages/settings/OrganizationSettingsPage').then(m => ({ default: m.OrganizationSettingsPage })));
const CalendarsSettingsPage = lazy(() => import('./pages/settings/CalendarsSettingsPage').then(m => ({ default: m.CalendarsSettingsPage })));
const AIAgentsSettingsPage = lazy(() => import('./pages/settings/AIAgentsSettingsPage').then(m => ({ default: m.AIAgentsSettingsPage })));
const EmailServicesSettingsPage = lazy(() => import('./pages/settings/EmailServicesSettingsPage').then(m => ({ default: m.EmailServicesSettingsPage })));
const PaymentsSettingsPage = lazy(() => import('./pages/settings/PaymentsSettingsPage').then(m => ({ default: m.PaymentsSettingsPage })));
const MigrationSettingsPage = lazy(() => import('./pages/settings/MigrationSettingsPage').then(m => ({ default: m.MigrationSettingsPage })));
const PhoneSystemSettingsPage = lazy(() => import('./pages/settings/PhoneSystemSettingsPage'));
const CustomFieldsSettingsPage = lazy(() => import('./pages/settings/CustomFieldsSettingsPage').then(m => ({ default: m.CustomFieldsSettingsPage })));
const CustomObjectsSettingsPage = lazy(() => import('./pages/settings/CustomObjectsSettingsPage').then(m => ({ default: m.CustomObjectsSettingsPage })));
const CustomObjectRecords = lazy(() => import('./pages/modules/CustomObjectRecords').then(m => ({ default: m.CustomObjectRecords })));
const CustomValuesSettingsPage = lazy(() => import('./pages/settings/CustomValuesSettingsPage').then(m => ({ default: m.CustomValuesSettingsPage })));
const ScoringSettingsPage = lazy(() => import('./pages/settings/ScoringSettingsPage'));
const IntegrationsSettingsPage = lazy(() => import('./pages/settings/IntegrationsSettingsPage').then(m => ({ default: m.IntegrationsSettingsPage })));
const BrandboardSettingsPage = lazy(() => import('./pages/settings/BrandboardSettingsPage').then(m => ({ default: m.BrandboardSettingsPage })));
const CRUDHealthCheckPage = lazy(() => import('./pages/settings/CRUDHealthCheckPage').then(m => ({ default: m.CRUDHealthCheckPage })));
const MeetProcessingSettingsPage = lazy(() => import('./pages/settings/MeetProcessingSettingsPage').then(m => ({ default: m.MeetProcessingSettingsPage })));
const BookingPage = lazy(() => import('./pages/public/BookingPage').then(m => ({ default: m.BookingPage })));
const CalendarLandingPage = lazy(() => import('./pages/public/CalendarLandingPage').then(m => ({ default: m.CalendarLandingPage })));
const RescheduleAppointmentPage = lazy(() => import('./pages/public/RescheduleAppointmentPage'));
const CancelAppointmentPage = lazy(() => import('./pages/public/CancelAppointmentPage'));
const PublicFormPage = lazy(() => import('./pages/public/PublicFormPage').then(m => ({ default: m.PublicFormPage })));
const PublicSurveyPage = lazy(() => import('./pages/public/PublicSurveyPage').then(m => ({ default: m.PublicSurveyPage })));
const PublicProposalPage = lazy(() => import('./pages/public/PublicProposalPage'));
const DeliverablePage = lazy(() => import('./pages/public/DeliverablePage').then(m => ({ default: m.DeliverablePage })));
const UnsubscribePage = lazy(() => import('./pages/public/UnsubscribePage').then(m => ({ default: m.UnsubscribePage })));
const PublicProposalSignPage = lazy(() => import('./pages/public/PublicProposalSignPage').then(m => ({ default: m.PublicProposalSignPage })));
const Contracts = lazy(() => import('./pages/modules/Contracts').then(m => ({ default: m.Contracts })));
const ContractDetail = lazy(() => import('./pages/modules/ContractDetail').then(m => ({ default: m.ContractDetail })));
const ContractBuilder = lazy(() => import('./pages/modules/ContractBuilder').then(m => ({ default: m.ContractBuilder })));
const PublicContractPage = lazy(() => import('./pages/public/PublicContractPage'));
const PublicContractSignPage = lazy(() => import('./pages/public/PublicContractSignPage').then(m => ({ default: m.PublicContractSignPage })));
const OAuthCallbackPage = lazy(() => import('./pages/public/OAuthCallbackPage').then(m => ({ default: m.OAuthCallbackPage })));
const PublicChangeRequestPage = lazy(() => import('./pages/public/PublicChangeRequestPage').then(m => ({ default: m.PublicChangeRequestPage })));
const PublicChangeRequestStatusPage = lazy(() => import('./pages/public/PublicChangeRequestStatusPage').then(m => ({ default: m.PublicChangeRequestStatusPage })));
// Client portal (contact-scoped)
const ClientPortalLayoutV2 = lazy(() => import('./layouts/ClientPortalLayoutV2').then(m => ({ default: m.ClientPortalLayoutV2 })));
const ClientPortalLoginPage = lazy(() => import('./pages/public/client-portal/LoginPage').then(m => ({ default: m.ClientPortalLoginPage })));
const ClientPortalVerifyCodePage = lazy(() => import('./pages/public/client-portal/VerifyCodePage').then(m => ({ default: m.ClientPortalVerifyCodePage })));
const ClientPortalDashboardPage = lazy(() => import('./pages/public/client-portal/DashboardPage').then(m => ({ default: m.ClientPortalDashboardPage })));
const ClientPortalHomePage = lazy(() => import('./pages/public/portal/ClientPortalHomePage').then(m => ({ default: m.ClientPortalHomePage })));
const ClientPortalChangeRequestsPage = lazy(() => import('./pages/public/portal/ClientPortalChangeRequestsPage').then(m => ({ default: m.ClientPortalChangeRequestsPage })));
const ClientPortalChangeRequestDetailPage = lazy(() => import('./pages/public/portal/ClientPortalChangeRequestDetailPage').then(m => ({ default: m.ClientPortalChangeRequestDetailPage })));
const ClientPortalDocumentsPage = lazy(() => import('./pages/public/portal/ClientPortalDocumentsPage').then(m => ({ default: m.ClientPortalDocumentsPage })));
const ClientPortalAiGovernancePage = lazy(() => import('./pages/public/portal/ClientPortalAiGovernancePage').then(m => ({ default: m.ClientPortalAiGovernancePage })));
const ClientPortalSupportTicketsPage = lazy(() => import('./pages/public/portal/ClientPortalSupportTicketsPage').then(m => ({ default: m.ClientPortalSupportTicketsPage })));
const ClientPortalSupportTicketDetailPage = lazy(() => import('./pages/public/portal/ClientPortalSupportTicketDetailPage').then(m => ({ default: m.ClientPortalSupportTicketDetailPage })));
const ClientPortalProjectBridge = lazy(() => import('./components/portal/ClientPortalProjectBridge').then(m => ({ default: m.ClientPortalProjectBridge })));


function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ThemeProvider>
          <ToastProvider>
          <DeviceProvider>
          <SidebarProvider>
            <Suspense fallback={<PageLoader />}>
            <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/auth/access-denied" element={<AccessDenied />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/unauthorized" element={<Unauthorized />} />
            <Route path="/feature-disabled" element={<FeatureDisabled />} />

            <Route
              element={
                <ProtectedRoute>
                  <DashboardLayout />
                </ProtectedRoute>
              }
            >
              <Route path="/" element={<StartPageRedirect><Dashboard /></StartPageRedirect>} />
              <Route path="/profile" element={<Profile />} />

              <Route
                path="/clara"
                element={
                  <ProtectedRoute permission="personal_assistant.view">
                    <ClaraPage />
                  </ProtectedRoute>
                }
              />

              <Route
                path="/conversations"
                element={
                  <ProtectedRoute permission="conversations.view" featureFlag="conversations">
                    <Conversations />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/conversations/:conversationId"
                element={
                  <ProtectedRoute permission="conversations.view" featureFlag="conversations">
                    <Conversations />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/calendars"
                element={
                  <ProtectedRoute permission="calendars.view" featureFlag="calendars">
                    <Calendars />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/calendars/:id"
                element={
                  <ProtectedRoute permission="calendars.view" featureFlag="calendars">
                    <CalendarDetail />
                  </ProtectedRoute>
                }
              />
              {/* The Inbox module was retired; Conversations is the owner's comms hub. */}
              <Route path="/inbox" element={<Navigate to="/conversations" replace />} />
              {/* Teams Chat and Google Chat were removed; Conversations is the comms hub. */}
              <Route path="/teams-chat" element={<Navigate to="/conversations" replace />} />
              <Route path="/google-chat" element={<Navigate to="/conversations" replace />} />
              {/* Tasks moved into Calendars as a tab. */}
              <Route path="/tasks" element={<Navigate to="/calendars?tab=tasks" replace />} />
              <Route
                path="/agent-tasks"
                element={
                  <ProtectedRoute permission="agent_tasks.view" featureFlag="agent_tasks">
                    <AgentTasks />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/agent-health"
                element={
                  <ProtectedRoute permission="agent_tasks.view" featureFlag="agent_tasks">
                    <AgentHealth />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/harvey"
                element={
                  <ProtectedRoute permission="harvey.view" featureFlag="harvey">
                    <Harvey />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/factory"
                element={
                  <ProtectedRoute permission="factory.view" featureFlag="factory">
                    <Factory />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/caio"
                element={
                  <ProtectedRoute permission="caio.view" featureFlag="caio">
                    <Caio />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/memory"
                element={
                  <ProtectedRoute permission="memory.view" featureFlag="memory">
                    <Memory />
                  </ProtectedRoute>
                }
              />
              {/* Meetings is no longer a module: meetings are picked inside the proposal and contract builders. */}
              <Route path="/meetings" element={<Navigate to="/proposals" replace />} />
              {/* Documents module: Proposals and Contracts as tabs that keep their URLs. The Docs creator was removed. */}
              <Route path="/documents" element={<FirstAccessibleTab tabs={documentsTabs} />} />
              <Route path="/docs" element={<Navigate to="/proposals" replace />} />
              <Route path="/docs/:id" element={<Navigate to="/proposals" replace />} />
              <Route element={<DocumentsLayout />}>
                <Route
                  path="/proposals"
                  element={
                    <ProtectedRoute permission="proposals.view" featureFlag="proposals">
                      <Proposals />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/contracts"
                  element={
                    <ProtectedRoute permission="contracts.view" featureFlag="contracts">
                      <Contracts />
                    </ProtectedRoute>
                  }
                />
              </Route>
              <Route
                path="/contacts"
                element={
                  <ProtectedRoute permission="contacts.view" featureFlag="contacts">
                    <Contacts />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/contacts/:id"
                element={
                  <ProtectedRoute permission="contacts.view" featureFlag="contacts">
                    <ContactDetail />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/custom-objects/:slug"
                element={
                  <ProtectedRoute>
                    <CustomObjectRecords />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/opportunities"
                element={
                  <ProtectedRoute permission="opportunities.view" featureFlag="opportunities">
                    <OpportunitiesLayout />
                  </ProtectedRoute>
                }
              >
                <Route index element={<Opportunities />} />
                <Route path="list" element={<OpportunitiesListPage />} />
                <Route path="pipelines" element={<PipelinesPage />} />
              </Route>
              <Route
                path="/opportunities/:id"
                element={
                  <ProtectedRoute permission="opportunities.view" featureFlag="opportunities">
                    <OpportunityDetail />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/government"
                element={
                  <ProtectedRoute permission="government.view" featureFlag="government">
                    <GovContractSearch />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/projects"
                element={
                  <ProtectedRoute permission="projects.view" featureFlag="projects">
                    <ProjectsLayout />
                  </ProtectedRoute>
                }
              >
                <Route index element={<Projects />} />
                <Route path="list" element={<ProjectsListPage />} />
                <Route path="pipelines" element={<ProjectPipelinesPage />} />
                <Route path="profitability" element={<PaymentsGate><ProjectProfitabilityPage /></PaymentsGate>} />
              </Route>
              <Route
                path="/projects/:id"
                element={
                  <ProtectedRoute permission="projects.view" featureFlag="projects">
                    <ProjectDetail />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/payments"
                element={
                  <ProtectedRoute permission="payments.view" featureFlag="payments">
                    <PaymentsGate>
                      <Payments />
                    </PaymentsGate>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/payments/invoices/:id"
                element={
                  <ProtectedRoute permission="payments.view" featureFlag="payments">
                    <PaymentsGate>
                      <InvoiceDetail />
                    </PaymentsGate>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/proposals/:id"
                element={
                  <ProtectedRoute permission="proposals.view" featureFlag="proposals">
                    <ProposalDetail />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/proposals/:id/build"
                element={
                  <ProtectedRoute permission="proposals.edit" featureFlag="proposals">
                    <ProposalBuilder />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/contracts/:id/build"
                element={
                  <ProtectedRoute permission="contracts.create" featureFlag="contracts">
                    <ContractBuilder />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/contracts/:id"
                element={
                  <ProtectedRoute permission="contracts.view" featureFlag="contracts">
                    <ContractDetail />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/marketing"
                element={
                  <ProtectedRoute permission="marketing.view" featureFlag="marketing">
                    <Marketing />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/marketing/forms"
                element={
                  <ProtectedRoute permission="marketing.forms.view" featureFlag="marketing">
                    <MarketingForms />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/email-templates"
                element={
                  <ProtectedRoute permission="marketing.forms.view" featureFlag="marketing">
                    <EmailTemplates />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/email-templates/:id"
                element={
                  <ProtectedRoute permission="marketing.forms.view" featureFlag="marketing">
                    <EmailTemplateEditor />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/marketing/forms/new"
                element={
                  <ProtectedRoute permission="marketing.forms.manage" featureFlag="marketing">
                    <FormBuilder />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/marketing/forms/:id"
                element={
                  <ProtectedRoute permission="marketing.forms.view" featureFlag="marketing">
                    <FormBuilder />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/marketing/forms/:id/edit"
                element={
                  <ProtectedRoute permission="marketing.forms.manage" featureFlag="marketing">
                    <FormBuilder />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/marketing/forms/:id/submissions"
                element={
                  <ProtectedRoute permission="marketing.forms.view" featureFlag="marketing">
                    <FormSubmissions />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/marketing/surveys"
                element={
                  <ProtectedRoute permission="marketing.surveys.view" featureFlag="marketing">
                    <MarketingSurveys />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/marketing/surveys/new"
                element={
                  <ProtectedRoute permission="marketing.surveys.manage" featureFlag="marketing">
                    <SurveyBuilder />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/marketing/surveys/:id"
                element={
                  <ProtectedRoute permission="marketing.surveys.view" featureFlag="marketing">
                    <SurveyBuilder />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/marketing/surveys/:id/edit"
                element={
                  <ProtectedRoute permission="marketing.surveys.manage" featureFlag="marketing">
                    <SurveyBuilder />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/marketing/surveys/:id/submissions"
                element={
                  <ProtectedRoute permission="marketing.surveys.view" featureFlag="marketing">
                    <SurveySubmissions />
                  </ProtectedRoute>
                }
              />
              {/* The approval hub outlived the workflow builder: CLARA/FRIDAY and the MCP
                  agent-approval tools queue owner decisions here and link to this exact URL. */}
              <Route
                path="/automation/approvals"
                element={
                  <ProtectedRoute permission="automation.view" featureFlag="automation">
                    <AutomationApprovals />
                  </ProtectedRoute>
                }
              />
              {/* The Automation (workflow builder) module was retired; old links land on the dashboard. */}
              <Route path="/automation/*" element={<Navigate to="/" replace />} />
              <Route
                path="/media"
                element={
                  <ProtectedRoute permission="media.view" featureFlag="media">
                    <MediaStorage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/reporting"
                element={
                  <ProtectedRoute permission="reporting.view" featureFlag="reporting">
                    <Reporting />
                  </ProtectedRoute>
                }
              />
              {/* Full Chat (/reporting/ai) was folded into the Generate Report card on /reporting. */}
              <Route path="/reporting/ai" element={<Navigate to="/reporting" replace />} />
              <Route path="/reporting/new" element={<Navigate to="/reporting" replace />} />
              <Route
                path="/reporting/:id"
                element={
                  <ProtectedRoute permission="reporting.view" featureFlag="reporting">
                    <ReportView />
                  </ProtectedRoute>
                }
              />

              <Route
                path="/settings"
                element={
                  <ProtectedRoute>
                    <SettingsLayout />
                  </ProtectedRoute>
                }
              >
                <Route index element={<MyProfilePage />} />
                <Route path="profile" element={<MyProfilePage />} />
                {/* Retired settings pages (Audit Logs, Conversations, Built-in Follow-Ups, Marketing
                    Pixels): old links land on Settings. Built-in Follow-Ups and Marketing Pixels
                    backends are retired too (migration *_retire_legacy_backends.sql). */}
                <Route path="audit-logs" element={<Navigate to="/settings" replace />} />
                <Route path="conversations" element={<Navigate to="/settings" replace />} />
                <Route path="meeting-follow-ups" element={<Navigate to="/settings" replace />} />
                <Route path="marketing-pixels" element={<Navigate to="/settings" replace />} />
                {/* Organization, Staff Management and Brandboard share one tabbed section. */}
                <Route element={<OrganizationSettingsLayout />}>
                  <Route
                    path="organization"
                    element={
                      <ProtectedRoute permission="settings.manage">
                        <OrganizationSettingsPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="staff"
                    element={
                      <ProtectedRoute permission="users.view">
                        <MyStaffPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="brandboard"
                    element={
                      <ProtectedRoute permission="brandboard.view" featureFlag="brandboard">
                        <BrandboardSettingsPage />
                      </ProtectedRoute>
                    }
                  />
                </Route>
                <Route
                  path="calendars"
                  element={
                    <ProtectedRoute featureFlag="calendars">
                      <CalendarsSettingsPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="ai-agents"
                  element={
                    <ProtectedRoute permission="ai.settings.view" featureFlag="ai_agents">
                      <AIAgentsSettingsPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="email-services"
                  element={
                    <ProtectedRoute featureFlag="email_services">
                      <EmailServicesSettingsPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="payments"
                  element={
                    <ProtectedRoute permission="payments.manage" featureFlag="payments">
                      <PaymentsSettingsPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="migration"
                  element={
                    <ProtectedRoute permission="settings.manage">
                      <MigrationSettingsPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="phone-system"
                  element={
                    <ProtectedRoute permission="phone.settings.view" featureFlag="phone_services">
                      <PhoneSystemSettingsPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="custom-fields"
                  element={
                    <ProtectedRoute permission="custom_fields.view">
                      <CustomFieldsSettingsPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="custom-objects"
                  element={
                    <ProtectedRoute permission="custom_fields.view">
                      <CustomObjectsSettingsPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="custom-values"
                  element={
                    <ProtectedRoute featureFlag="custom_values">
                      <CustomValuesSettingsPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="scoring"
                  element={
                    <ProtectedRoute featureFlag="scoring_management">
                      <ScoringSettingsPage />
                    </ProtectedRoute>
                  }
                />
                {/* One brandboard per org: the Brandboard tab is its editor. */}
                <Route path="brandboard/:brandId" element={<Navigate to="/settings/brandboard" replace />} />
                <Route
                  path="integrations"
                  element={
                    <ProtectedRoute featureFlag="integrations">
                      <IntegrationsSettingsPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="system/crud-health-check"
                  element={
                    <ProtectedRoute permission="system_tools.view">
                      <CRUDHealthCheckPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="system/meet-processing"
                  element={
                    <ProtectedRoute permission="system_tools.view">
                      <MeetProcessingSettingsPage />
                    </ProtectedRoute>
                  }
                />
              </Route>
              {/* The Audit Logs page was removed (audit rows are still written). */}
              <Route path="/audit-logs" element={<Navigate to="/settings" replace />} />
            </Route>

            <Route path="/book/:calendarSlug" element={<CalendarLandingPage />} />
            <Route path="/book/:calendarSlug/:typeSlug" element={<BookingPage />} />
            <Route path="/appointments/reschedule/:token" element={<RescheduleAppointmentPage />} />
            <Route path="/appointments/cancel/:token" element={<CancelAppointmentPage />} />
            <Route path="/f/:slug" element={<PublicFormPage />} />
            <Route path="/s/:slug" element={<PublicSurveyPage />} />
            <Route path="/p/:token" element={<PublicProposalPage />} />
            <Route path="/deliverable/:id" element={<DeliverablePage />} />
            <Route path="/unsubscribe/:slug" element={<UnsubscribePage />} />
            <Route path="/sign/proposal/:requestId" element={<PublicProposalSignPage />} />
            <Route path="/c/:token" element={<PublicContractPage />} />
            <Route path="/sign/contract/:requestId" element={<PublicContractSignPage />} />
            <Route path="/oauth/google-calendar/callback" element={<OAuthCallbackPage />} />
            <Route path="/project-change/submit" element={<PublicChangeRequestPage />} />
            <Route path="/project-change/status/:requestId" element={<PublicChangeRequestStatusPage />} />
            {/* Client portal — contact-scoped, permanent URL */}
            <Route path="/client-portal" element={<ClientPortalLayoutV2 />}>
              <Route index element={<ClientPortalLoginPage />} />
              <Route path="verify" element={<ClientPortalVerifyCodePage />} />
              <Route path="dashboard" element={<ClientPortalDashboardPage />} />
              <Route path="projects/:projectId" element={<ClientPortalProjectBridge />}>
                <Route index element={<ClientPortalHomePage />} />
                <Route path="change-requests" element={<ClientPortalChangeRequestsPage />} />
                <Route path="change-requests/:requestId" element={<ClientPortalChangeRequestDetailPage />} />
                <Route path="support-tickets" element={<ClientPortalSupportTicketsPage />} />
                <Route path="support-tickets/:ticketId" element={<ClientPortalSupportTicketDetailPage />} />
                <Route path="documents" element={<ClientPortalDocumentsPage />} />
                <Route path="ai-governance" element={<ClientPortalAiGovernancePage />} />
              </Route>
            </Route>
            <Route path="*" element={<NotFound />} />
            </Routes>
            </Suspense>
          </SidebarProvider>
          </DeviceProvider>
          </ToastProvider>
        </ThemeProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
