import React, { useEffect, useState } from 'react';
import api from '../lib/api';
import { useAuth } from '../components/AuthContext';
import { 
  Plus, 
  Search, 
  UserCheck, 
  Check, 
  X, 
  Edit3, 
  ShieldAlert, 
  CheckCircle2, 
  History,
  Users,
  Trash2
} from 'lucide-react';

export default function StaffManagement() {
  const { user } = useAuth();

  const [staffList, setStaffList] = useState<any[]>([]);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingStaff, setEditingStaff] = useState<any>(null);

  // Form State
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'SUPER_ADMIN' | 'STAFF'>('STAFF');
  const [status, setStatus] = useState<string>('authorized');
  const [password, setPassword] = useState('');

  // Search & Filters
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [roleFilter, setRoleFilter] = useState('ALL');

  // Status banners
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // STAFF is the user-facing name of the LOGISTICS backend permission role.
  const displayRole = (r: string): 'SUPER_ADMIN' | 'STAFF' => (r === 'LOGISTICS' || r === 'STAFF') ? 'STAFF' : 'SUPER_ADMIN';

  // Deletion Confirmation
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState<string>('');

  const handleExecuteDeleteStaff = async () => {
    if (!deleteConfirmId) return;
    try {
      setError(null);
      setSuccess(null);
      const res = await api.delete(`/v1/admin/staff/${deleteConfirmId}`);
      setSuccess(res.message || 'Staff member deleted successfully.');
      setDeleteConfirmId(null);
      setDeleteConfirmName('');
      loadStaff();
      loadAuditLogs();
    } catch (err: any) {
      setError(err.message || 'Failed to delete staff member.');
      setDeleteConfirmId(null);
      setDeleteConfirmName('');
    }
  };

  useEffect(() => {
    if (user?.role === 'SUPER_ADMIN') {
      loadStaff();
      loadAuditLogs();
    }
  }, [user]);

  async function loadStaff() {
    setLoading(true);
    try {
      const data = await api.get('/staff');
      setStaffList(data.staff || []);
    } catch (e: any) {
      setError(e.message || 'Failed to fetch staff members list');
    } finally {
      setLoading(false);
    }
  }

  async function loadAuditLogs() {
    try {
      // Newest-first, paginated (large limit so client-side filtering sees enough history)
      const data = await api.get('/logs/audit?limit=500');
      const staffLogs = (data.logs || []).filter((l: any) => 
        l.action.includes('STAFF') || l.action.includes('USER')
      );
      setAuditLogs(staffLogs);
    } catch {}
  }

  const handleOpenCreate = () => {
    setEditingStaff(null);
    setName('');
    setEmail('');
    setRole('STAFF');
    setStatus('authorized');
    setPassword('');
    setError(null);
    setSuccess(null);
    setShowModal(true);
  };

  const handleOpenEdit = (staff: any) => {
    setEditingStaff(staff);
    setName(staff.name);
    setEmail(staff.email);
    setRole(displayRole(staff.role));
    setStatus(staff.status);
    setPassword('');
    setError(null);
    setSuccess(null);
    setShowModal(true);
  };

  const handleToggleStatus = async (staff: any, newStatus: string) => {
    try {
      setError(null);
      setSuccess(null);
      await api.put(`/staff/${staff.id}`, { status: newStatus });
      setSuccess(`Staff status changed to '${newStatus}'`);
      loadStaff();
      loadAuditLogs();
    } catch (err: any) {
      setError(err.message || 'Failed to change status');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !email || !role || !status) {
      setError('Name, email, role, and status are mandatory.');
      return;
    }

    if (!editingStaff && !password) {
      setError('An initial secure password is required to onboard new staff.');
      return;
    }

    setSubmitting(true);
    setError(null);
    setSuccess(null);

    const payload: any = {
      name,
      email,
      role,
      status
    };

    if (password) {
      payload.password = password;
    }

    try {
      if (editingStaff) {
        await api.put(`/staff/${editingStaff.id}`, payload);
        setSuccess('Staff profile updated successfully!');
      } else {
        await api.post('/staff', payload);
        setSuccess('New staff account onboarded successfully!');
      }
      setTimeout(() => {
        setShowModal(false);
        loadStaff();
        loadAuditLogs();
      }, 800);
    } catch (err: any) {
      setError(err.message || 'Onboarding request failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const filteredStaff = staffList.filter(s => {
    const matchesSearch = 
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.email.toLowerCase().includes(search.toLowerCase());

    const matchesStatus = statusFilter === 'ALL' || s.status.toUpperCase() === statusFilter.toUpperCase();
    const matchesRole = roleFilter === 'ALL' || displayRole(s.role) === roleFilter;

    return matchesSearch && matchesStatus && matchesRole;
  });

  if (user?.role !== 'SUPER_ADMIN') {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <ShieldAlert className="w-12 h-12 text-rose-500 mb-4 animate-bounce" />
        <h2 className="text-lg font-bold text-slate-900 dark:text-white">Access Restricted</h2>
        <p className="text-slate-500 dark:text-slate-400 text-xs mt-1 max-w-sm">
          Staff Directory and authorization control are exclusive to Master Super Administrators.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-950 dark:text-white tracking-tight flex items-center gap-2">
            <Users className="w-6 h-6 text-slate-400" />
            Staff Management
          </h1>
          <p className="text-slate-400 text-xs mt-1">
            Authorize, onboard, and audit corporate staff members and administrators.
          </p>
        </div>

        <button
          onClick={handleOpenCreate}
          className="px-4 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors shadow-md shadow-blue-500/10 flex items-center gap-2 cursor-pointer animate-fade-in"
        >
          <Plus className="w-4 h-4" />
          Onboard New Staff
        </button>
      </div>

      {/* SEARCH AND FILTERS */}
      <div className="p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl flex flex-col md:flex-row gap-4 items-center justify-between shadow-sm">
        <div className="relative w-full md:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search name, email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:text-white"
          />
        </div>

        <div className="flex gap-2 w-full md:w-auto">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="flex-1 md:flex-none px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:text-white"
          >
            <option value="ALL">All Statuses</option>
            <option value="authorized">Authorized</option>
            <option value="approved">Approved</option>
            <option value="blocked">Blocked</option>
          </select>

          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            className="flex-1 md:flex-none px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:text-white"
          >
            <option value="ALL">All Roles</option>
            <option value="SUPER_ADMIN">Super Admin</option>
            <option value="STAFF">STAFF</option>
          </select>
        </div>
      </div>

      {/* ERROR/SUCCESS FEEDBACK */}
      {error && !showModal && (
        <div className="p-4 bg-rose-50 dark:bg-rose-950/20 border border-rose-100 dark:border-rose-900/30 text-rose-600 dark:text-rose-400 text-xs font-medium rounded-xl flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {success && !showModal && (
        <div className="p-4 bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-100 dark:border-emerald-900/30 text-emerald-600 dark:text-emerald-400 text-xs font-medium rounded-xl flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{success}</span>
        </div>
      )}

      {/* TWO COLUMNS: DIRECTORY & AUDIT LOGS */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Staff Table Directory */}
        <div className="lg:col-span-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-800">
            <h2 className="text-sm font-bold text-slate-800 dark:text-slate-100 uppercase tracking-wider">Registered Corporate Staff</h2>
          </div>

          {loading ? (
            <div className="p-12 text-center">
              <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-2"></div>
              <p className="text-xs text-slate-400 font-mono">Loading staff directory...</p>
            </div>
          ) : filteredStaff.length === 0 ? (
            <div className="p-12 text-center text-slate-400 text-xs">
              No staff members match the active query/filters.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-100 dark:border-slate-800 text-[10px] font-mono text-slate-400 uppercase tracking-wider bg-slate-50/50 dark:bg-slate-900/40">
                    <th className="py-3 px-6">Name & Email</th>
                    <th className="py-3 px-4">System Role</th>
                    <th className="py-3 px-4">Account Status</th>
                    <th className="py-3 px-6 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/50 text-xs">
                  {filteredStaff.map((staff) => {
                    const statusLower = (staff.status || '').toLowerCase();
                    const isAuthorized = statusLower === 'authorized' || statusLower === 'approved' || statusLower === 'active';
                    return (
                      <tr key={staff.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-900/30 transition-colors">
                        <td className="py-3.5 px-6">
                          <div className="font-semibold text-slate-800 dark:text-slate-100">{staff.name}</div>
                          <div className="text-[11px] text-slate-400 font-mono">{staff.email}</div>
                        </td>
                        <td className="py-3.5 px-4 font-mono text-[11px]">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            staff.role === 'SUPER_ADMIN' 
                              ? 'bg-purple-50 dark:bg-purple-950/30 text-purple-600 dark:text-purple-400 border border-purple-200/50 dark:border-purple-900/20' 
                              : 'bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 border border-blue-200/50 dark:border-blue-900/20'
                          }`}>
                            {displayRole(staff.role)}
                          </span>
                        </td>
                        <td className="py-3.5 px-4">
                          <div className="flex items-center gap-1.5">
                            <span className={`w-1.5 h-1.5 rounded-full ${
                              statusLower === 'authorized' || statusLower === 'active'
                                ? 'bg-emerald-500' 
                                : statusLower === 'approved'
                                ? 'bg-blue-500'
                                : 'bg-rose-500'
                            }`} />
                            <span className="font-mono text-[11px] capitalize text-slate-600 dark:text-slate-300">
                              {staff.status}
                            </span>
                          </div>
                        </td>
                        <td className="py-3.5 px-6 text-right space-x-1.5">
                          <button
                            onClick={() => handleOpenEdit(staff)}
                            className="p-1.5 text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition-colors inline-block cursor-pointer"
                            title="Edit Profile"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                          
                          {staff.email !== 'aronkumar.logistics@gmail.com' && (
                            <>
                              {statusLower !== 'authorized' && (
                                <button
                                  onClick={() => handleToggleStatus(staff, 'authorized')}
                                  className="px-2 py-1 bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/30 dark:hover:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400 border border-emerald-200/50 dark:border-emerald-900/30 rounded text-[10px] font-bold tracking-wide uppercase transition-all inline-block cursor-pointer"
                                >
                                  Authorize
                                </button>
                              )}
                              {statusLower !== 'approved' && (
                                <button
                                  onClick={() => handleToggleStatus(staff, 'approved')}
                                  className="px-2 py-1 bg-blue-50 hover:bg-blue-100 dark:bg-blue-950/30 dark:hover:bg-blue-900/40 text-blue-600 dark:text-blue-400 border border-blue-200/50 dark:border-blue-900/30 rounded text-[10px] font-bold tracking-wide uppercase transition-all inline-block cursor-pointer"
                                >
                                  Approve
                                </button>
                              )}
                              {statusLower !== 'blocked' && (
                                <button
                                  onClick={() => handleToggleStatus(staff, 'blocked')}
                                  className="px-2 py-1 bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/20 dark:hover:bg-rose-900/40 text-rose-600 dark:text-rose-400 border border-rose-200/40 dark:border-rose-900/20 rounded text-[10px] font-bold tracking-wide uppercase transition-all inline-block cursor-pointer"
                                >
                                  Block
                                </button>
                              )}
                              {user?.role === 'SUPER_ADMIN' && (
                                <button
                                  onClick={() => {
                                    setDeleteConfirmId(staff.id);
                                    setDeleteConfirmName(staff.name);
                                  }}
                                  className="p-1 text-rose-600 hover:text-rose-800 dark:text-rose-400 dark:hover:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/30 rounded transition-colors inline-block cursor-pointer"
                                  title="Delete Account"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Audit Log column */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm p-6 space-y-4">
          <div className="flex items-center gap-2 text-slate-800 dark:text-slate-100 font-bold text-xs uppercase tracking-wider border-b border-slate-100 dark:border-slate-800 pb-3">
            <History className="w-4 h-4 text-slate-400" />
            <span>Staff Activity Ledger</span>
          </div>

          <div className="space-y-3 max-h-[480px] overflow-y-auto pr-1">
            {auditLogs.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-6">No administrative actions logged yet.</p>
            ) : (
              auditLogs.map((log) => (
                <div key={log.id} className="p-3 bg-slate-50/50 dark:bg-slate-950 rounded-xl border border-slate-200/40 dark:border-slate-800/50 space-y-1">
                  <div className="flex justify-between items-start gap-2">
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wide font-mono">
                      {log.action}
                    </span>
                    <span className="text-[9px] text-slate-400 font-mono">
                      {new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-600 dark:text-slate-300">
                    Triggered by <span className="font-semibold text-slate-700 dark:text-slate-200">{log.userEmail}</span>
                  </p>
                  {log.ipAddress && (
                    <div className="text-[9px] text-slate-400 font-mono flex items-center justify-between">
                      <span>IP: {log.ipAddress}</span>
                      <span className="text-slate-400 capitalize">{log.role?.replace('_', ' ').toLowerCase()}</span>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

      </div>

      {/* POPUP MODAL FOR STAFF CREATION/EDIT */}
      {showModal && (
        <div className="fixed inset-0 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden transform transition-all animate-scale-up">
            
            <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center bg-slate-50/50 dark:bg-slate-900/40">
              <h3 className="font-bold text-slate-900 dark:text-white text-sm uppercase tracking-wider">
                {editingStaff ? 'Modify Staff Profile' : 'Onboard New Staff Member'}
              </h3>
              <button
                onClick={() => setShowModal(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer p-1 rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              {error && (
                <div className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900/30 text-rose-600 dark:text-rose-400 text-xs font-medium flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
              {success && (
                <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900/30 text-emerald-600 dark:text-emerald-400 text-xs font-medium flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>{success}</span>
                </div>
              )}

              {/* Full Name */}
              <div>
                <label className="block text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wider mb-1">
                  Full Name
                </label>
                <input
                  type="text"
                  required
                  placeholder="John Doe"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </div>

              {/* Email */}
              <div>
                <label className="block text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wider mb-1">
                  Corporate Email
                </label>
                <input
                  type="email"
                  required
                  placeholder="name@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={!!editingStaff}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:opacity-50"
                />
              </div>

              {/* Password */}
              <div>
                <label className="block text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wider mb-1">
                  {editingStaff ? 'Reset Password (Optional)' : 'Initial Password'}
                </label>
                <input
                  type="password"
                  required={!editingStaff}
                  placeholder={editingStaff ? 'Leave empty to keep current password' : '••••••••'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </div>

              {/* Role Selection */}
              <div>
                <label className="block text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wider mb-1">
                  System Role
                </label>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as any)}
                  disabled={editingStaff?.email === 'aronkumar.logistics@gmail.com'}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                >
                  <option value="STAFF">STAFF</option>
                  <option value="SUPER_ADMIN">Super Admin</option>
                </select>
              </div>

              {/* Status Selection */}
              <div>
                <label className="block text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wider mb-1">
                  Authorization Status
                </label>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  disabled={editingStaff?.email === 'aronkumar.logistics@gmail.com'}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                >
                  <option value="authorized">authorized</option>
                  <option value="approved">approved</option>
                  <option value="blocked">blocked</option>
                </select>
              </div>

              {/* Actions */}
              <div className="flex gap-3 justify-end pt-2 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-xs font-semibold border border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
                >
                  {submitting ? 'Processing...' : editingStaff ? 'Save Changes' : 'Confirm Onboard'}
                </button>
              </div>

            </form>

          </div>
        </div>
      )}

      {/* Permanent Deletion Confirmation Modal */}
      {deleteConfirmId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 backdrop-blur-sm p-4 animate-fade-in">
          <div className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-xl space-y-4 animate-scale-up">
            <div className="flex items-center gap-3 text-rose-600 dark:text-rose-400">
              <div className="p-2 bg-rose-50 dark:bg-rose-950/30 rounded-xl">
                <Trash2 className="w-6 h-6" />
              </div>
              <h3 className="font-sans font-bold text-lg text-slate-900 dark:text-white">Confirm Permanent Deletion</h3>
            </div>
            
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              Are you sure you want to permanently delete <strong>{deleteConfirmName}</strong>? This action cannot be undone and will remove all associated logs/bids.
            </p>

            <div className="flex gap-3 justify-end pt-2 border-t border-slate-100 dark:border-slate-800">
              <button
                type="button"
                onClick={() => {
                  setDeleteConfirmId(null);
                  setDeleteConfirmName('');
                }}
                className="px-4 py-2 text-xs font-semibold border border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleExecuteDeleteStaff}
                className="px-4 py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-700 text-white rounded-lg transition-colors cursor-pointer"
              >
                Permanently Delete
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
