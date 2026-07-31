import React, { useEffect, useState } from 'react';
import api from '../lib/api';
import { useAuth } from '../components/AuthContext';
import { 
  Plus, 
  Search, 
  Filter, 
  Truck, 
  Check, 
  X, 
  Edit3, 
  ShieldAlert, 
  CheckCircle2, 
  History,
  FileSpreadsheet,
  Trash2
} from 'lucide-react';

export default function OnboardTransporters() {
  const { user } = useAuth();

  const [transporters, setTransporters] = useState<any[]>([]);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingTr, setEditingTr] = useState<any>(null);

  // Form State
  const [companyName, setCompanyName] = useState('');
  const [contactPerson, setContactPerson] = useState('');
  const [email, setEmail] = useState('');
  const [mobileNumber, setMobileNumber] = useState('');
  const [gstNumber, setGstNumber] = useState('');
  const [panNumber, setPanNumber] = useState('');
  const [selectedVehicles, setSelectedVehicles] = useState<string[]>([]);
  const [status, setStatus] = useState<'ACTIVE' | 'INACTIVE'>('ACTIVE');
  const [password, setPassword] = useState('');

  // Search & Status filters
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');

  // Notification banners
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Deletion Confirmation
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState<string>('');

  const handleExecuteDeleteTransporter = async () => {
    if (!deleteConfirmId) return;
    try {
      setError(null);
      setSuccess(null);
      const res = await api.delete(`/v1/admin/transporters/${deleteConfirmId}`);
      setSuccess(res.message || 'Transporter deleted successfully.');
      setDeleteConfirmId(null);
      setDeleteConfirmName('');
      loadTransporters();
      if (user?.role === 'SUPER_ADMIN' || user?.role === 'LOGISTICS') {
        loadAuditLogs();
      }
    } catch (err: any) {
      setError(err.message || 'Failed to delete transporter.');
      setDeleteConfirmId(null);
      setDeleteConfirmName('');
    }
  };

  // Available vehicles standard list
  const vehicleOptions = ['32 FT Trailer', '20 FT Container', '40 FT Container', '19 FT Open Truck'];

  useEffect(() => {
    loadTransporters();
    if (user?.role === 'SUPER_ADMIN' || user?.role === 'LOGISTICS') {
      loadAuditLogs();
    }
  }, [user]);

  async function loadTransporters() {
    setLoading(true);
    try {
      const data = await api.get('/transporters');
      setTransporters(data.transporters || []);
    } catch (e: any) {
      setError(e.message || 'Failed to fetch transporters list');
    } finally {
      setLoading(false);
    }
  }

  async function loadAuditLogs() {
    try {
      const data = await api.get('/logs/audit');
      // Filter logs only related to transporter onboarding or modifications
      const transLogs = (data.logs || []).filter((l: any) => 
        l.action.includes('TRANSPORTER') || l.action.includes('ONBOARD')
      );
      setAuditLogs(transLogs.reverse());
    } catch {}
  }

  // GST format validator: 15 characters (e.g. 27AAAAA1111A1Z1)
  const isGstValid = (gst: string) => /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(gst.toUpperCase());
  // PAN format validator: 10 characters (e.g. AAAAA1111A)
  const isPanValid = (pan: string) => /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(pan.toUpperCase());

  const handleOpenCreate = () => {
    setEditingTr(null);
    setCompanyName('');
    setContactPerson('');
    setEmail('');
    setMobileNumber('');
    setGstNumber('');
    setPanNumber('');
    setSelectedVehicles([]);
    setStatus('ACTIVE');
    setPassword('');
    setError(null);
    setSuccess(null);
    setShowModal(true);
  };

  const handleOpenEdit = (tr: any) => {
    setEditingTr(tr);
    setCompanyName(tr.companyName);
    setContactPerson(tr.contactPerson);
    setEmail(tr.email);
    setMobileNumber(tr.mobileNumber);
    setGstNumber(tr.gstNumber);
    setPanNumber(tr.panNumber);
    setSelectedVehicles(tr.vehicleTypes || []);
    setStatus(tr.status);
    setPassword('');
    setError(null);
    setSuccess(null);
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!companyName || !contactPerson || !email || !mobileNumber || !gstNumber || !panNumber) {
      setError('All parameters are mandatory to register a transporter.');
      return;
    }

    if (!editingTr && !password) {
      setError('An initial secure password is required to onboard a new transporter.');
      return;
    }

    if (!isGstValid(gstNumber)) {
      setError('Invalid GSTIN format. Standard GST must be 15 alphanumeric characters (e.g., 27AAAAA1111A1Z1).');
      return;
    }

    if (!isPanValid(panNumber)) {
      setError('Invalid PAN format. Standard PAN must be 10 characters (e.g., AAAAA1111A).');
      return;
    }

    // Ensure mobile starts with +91 or country code
    let formattedPhone = mobileNumber.trim();
    if (!formattedPhone.startsWith('+')) {
      if (formattedPhone.length === 10) formattedPhone = `+91${formattedPhone}`;
      else formattedPhone = `+${formattedPhone}`;
    }

    setSubmitting(true);
    setError(null);
    setSuccess(null);

    const payload: any = {
      companyName,
      contactPerson,
      email,
      mobileNumber: formattedPhone,
      gstNumber: gstNumber.toUpperCase(),
      panNumber: panNumber.toUpperCase(),
      vehicleTypes: selectedVehicles,
      status
    };

    if (password) {
      payload.password = password;
    }

    try {
      if (editingTr) {
        await api.put(`/transporters/${editingTr.id}`, payload);
        setSuccess('Transporter profile modified successfully!');
      } else {
        await api.post('/transporters', payload);
        setSuccess('New transporter carrier registered and eligible for invitations!');
      }
      setTimeout(() => {
        setShowModal(false);
        loadTransporters();
        if (user?.role === 'SUPER_ADMIN' || user?.role === 'LOGISTICS') {
          loadAuditLogs();
        }
      }, 800);
    } catch (err: any) {
      setError(err.message || 'Onboarding request failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const toggleVehicle = (v: string) => {
    setSelectedVehicles(prev => 
      prev.includes(v) ? prev.filter(x => x !== v) : [...prev, v]
    );
  };

  // Filter transporters
  const filteredTransporters = transporters.filter(t => {
    const matchesSearch = 
      t.companyName.toLowerCase().includes(search.toLowerCase()) ||
      t.contactPerson.toLowerCase().includes(search.toLowerCase()) ||
      t.gstNumber.toLowerCase().includes(search.toLowerCase()) ||
      t.panNumber.toLowerCase().includes(search.toLowerCase());

    const matchesStatus = statusFilter === 'ALL' || t.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-950 dark:text-white tracking-tight flex items-center gap-2">
            <Truck className="w-6 h-6 text-slate-400" />
            Carrier Directory
          </h1>
          <p className="text-slate-400 text-xs mt-1">
            Securely register, manage, and audit transporter accounts. No public registration permitted.
          </p>
        </div>

        {(user?.role === 'SUPER_ADMIN' || user?.role === 'LOGISTICS') && user?.status?.toLowerCase() !== 'approved' && (
          <button
            onClick={handleOpenCreate}
            className="px-4 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors shadow-md shadow-blue-500/10 flex items-center gap-2 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Register Transporter
          </button>
        )}
      </div>

      {/* SEARCH AND FILTERS */}
      <div className="p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl flex flex-col md:flex-row gap-4 items-center justify-between shadow-sm">
        <div className="relative w-full md:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search company, contact, GST..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:text-white"
          />
        </div>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:text-white"
        >
          <option value="ALL">All Carriers</option>
          <option value="ACTIVE">Active Only</option>
          <option value="INACTIVE">Inactive Only</option>
        </select>
      </div>

      {/* BENTO LAYOUT: DIR + AUDIT TIMELINE */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        
        {/* Left Column: Transporters Cards */}
        <div className="lg:col-span-2 space-y-4">
          {loading ? (
            <div className="p-12 text-center text-xs text-slate-400 animate-pulse">
              Retrieving registered carriers...
            </div>
          ) : filteredTransporters.length === 0 ? (
            <div className="p-16 text-center bg-white dark:bg-slate-900 border rounded-2xl space-y-2">
              <Truck className="w-8 h-8 text-slate-300 mx-auto" />
              <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">No Carriers Found</div>
              <p className="text-xs text-slate-400">Add carriers via the onboarding panel.</p>
            </div>
          ) : (
            filteredTransporters.map(tr => (
              <div 
                key={tr.id}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-sm space-y-4 hover:border-slate-300 dark:hover:border-slate-700 transition-colors"
              >
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h3 className="font-bold text-sm text-slate-900 dark:text-white">{tr.companyName}</h3>
                    <div className="text-xs text-slate-400 mt-0.5">Contact: <strong className="text-slate-600 dark:text-slate-300">{tr.contactPerson}</strong></div>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold tracking-wider uppercase border ${
                      tr.status === 'ACTIVE' 
                        ? 'bg-emerald-50 text-emerald-600 border-emerald-200' 
                        : 'bg-rose-50 text-rose-500 border-rose-200'
                    }`}>
                      {tr.status}
                    </span>
                    
                    {(user?.role === 'SUPER_ADMIN' || user?.role === 'LOGISTICS') && user?.status?.toLowerCase() !== 'approved' && (
                      <button
                        onClick={() => handleOpenEdit(tr)}
                        className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-900 text-slate-400 hover:text-slate-600 transition-colors cursor-pointer"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {user?.role === 'SUPER_ADMIN' && (
                      <button
                        onClick={() => {
                          setDeleteConfirmId(tr.id);
                          setDeleteConfirmName(tr.companyName);
                        }}
                        className="p-1.5 rounded-lg border border-rose-200 hover:bg-rose-50 text-rose-500 hover:text-rose-700 dark:border-rose-900/30 dark:hover:bg-rose-950/20 transition-colors cursor-pointer"
                        title="Delete Transporter"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-3 border-t border-slate-50 dark:border-slate-900/50 text-[11px] font-mono">
                  <div>
                    <span className="text-slate-400 block">Mobile (SMS/WA)</span>
                    <span className="text-slate-700 dark:text-slate-300 font-bold">{tr.mobileNumber}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Email Address</span>
                    <span className="text-slate-700 dark:text-slate-300 font-bold truncate block">{tr.email}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">GSTIN Number</span>
                    <span className="text-slate-700 dark:text-slate-300 font-bold">{tr.gstNumber}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">PAN Number</span>
                    <span className="text-slate-700 dark:text-slate-300 font-bold">{tr.panNumber}</span>
                  </div>
                </div>

                {tr.vehicleTypes?.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {tr.vehicleTypes.map((v: string) => (
                      <span key={v} className="px-2 py-0.5 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 rounded text-[9px] font-semibold">
                        {v}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Right Column: Super Admin Audit Trailing timeline */}
        <div className="space-y-6">
          {(user?.role === 'SUPER_ADMIN' || user?.role === 'LOGISTICS') && (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm">
              <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-900 flex items-center gap-2">
                <History className="w-4 h-4 text-slate-400" />
                <h2 className="text-sm font-bold text-slate-950 dark:text-white">Profile Modification Logs</h2>
              </div>
              <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
                {auditLogs.length === 0 ? (
                  <div className="text-center text-xs text-slate-400 py-6">No edits logged yet.</div>
                ) : (
                  auditLogs.map((log) => (
                    <div key={log.id} className="text-xs border-b border-slate-50 dark:border-slate-900/50 pb-3 last:border-none last:pb-0">
                      <div className="flex justify-between text-[9px] font-mono text-slate-400">
                        <span>{new Date(log.timestamp).toLocaleString()}</span>
                        <span>BY {log.userEmail?.split('@')[0]}</span>
                      </div>
                      <div className="font-semibold text-slate-800 dark:text-slate-200 mt-1">{log.action}</div>
                      {log.oldValue && (
                        <div className="mt-2 text-[10px] font-mono p-2 bg-slate-50 dark:bg-slate-950 border dark:border-slate-900 rounded overflow-x-auto text-slate-400">
                          <strong>Before:</strong> {log.oldValue.length > 80 ? log.oldValue.substring(0, 80) + '...' : log.oldValue}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* CREATE/EDIT MODAL */}
      {showModal && (
        <div className="fixed inset-0 bg-black/60 dark:bg-black/80 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-2xl flex flex-col max-h-[90vh]">
            {/* Header */}
            <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-900 flex justify-between items-center">
              <div>
                <h3 className="text-base font-bold text-slate-950 dark:text-white">
                  {editingTr ? 'Edit Carrier Profile' : 'Onboard Transporter Carrier'}
                </h3>
                <p className="text-xs text-slate-400">Complete corporate registration verification parameters.</p>
              </div>
              <button 
                onClick={() => setShowModal(false)}
                className="p-1 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-400 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Error banner inside modal */}
            {error && (
              <div className="mx-6 mt-4 flex items-start gap-2.5 p-3 rounded-lg bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900/30 text-rose-600 dark:text-rose-400 text-xs font-medium">
                <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}
            {success && (
              <div className="mx-6 mt-4 flex items-start gap-2.5 p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900/30 text-emerald-600 dark:text-emerald-400 text-xs font-medium">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{success}</span>
              </div>
            )}

            {/* Body */}
            <form id="trans-form" onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Company Registered Name *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Gati Transport Ltd"
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent focus:ring-2 focus:ring-blue-500/20"
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Primary Contact Person *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Ramesh Gati"
                    value={contactPerson}
                    onChange={(e) => setContactPerson(e.target.value)}
                    className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent focus:ring-2 focus:ring-blue-500/20"
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Verification Email Address *</label>
                  <input
                    type="email"
                    required
                    disabled={!!editingTr} // Lock email to block account hijacking
                    placeholder="e.g. gati@transport.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent focus:ring-2 focus:ring-blue-500/20 disabled:bg-slate-50 dark:disabled:bg-slate-900 text-slate-500"
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">WhatsApp-Enabled Mobile *</label>
                  <input
                    type="tel"
                    required
                    disabled={!!editingTr} // Lock phone to block account hijacking
                    placeholder="e.g. 9876543210"
                    value={mobileNumber}
                    onChange={(e) => setMobileNumber(e.target.value)}
                    className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent focus:ring-2 focus:ring-blue-500/20 disabled:bg-slate-50 dark:disabled:bg-slate-900 text-slate-500"
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">GSTIN Number (15 alphanumeric) *</label>
                  <input
                    type="text"
                    required
                    maxLength={15}
                    placeholder="e.g. 27AAAAA1111A1Z1"
                    value={gstNumber}
                    onChange={(e) => setGstNumber(e.target.value)}
                    className="w-full px-3.5 py-2 text-sm font-mono rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent focus:ring-2 focus:ring-blue-500/20"
                  />
                  <div className={`text-[10px] mt-1 font-semibold flex items-center gap-1 ${gstNumber && isGstValid(gstNumber) ? 'text-emerald-500' : 'text-slate-400'}`}>
                    <span>• Verified GSTIN Format</span>
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">PAN Card Number (10 Alphanumeric) *</label>
                  <input
                    type="text"
                    required
                    maxLength={10}
                    placeholder="e.g. AAAAA1111A"
                    value={panNumber}
                    onChange={(e) => setPanNumber(e.target.value)}
                    className="w-full px-3.5 py-2 text-sm font-mono rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent focus:ring-2 focus:ring-blue-500/20"
                  />
                  <div className={`text-[10px] mt-1 font-semibold flex items-center gap-1 ${panNumber && isPanValid(panNumber) ? 'text-emerald-500' : 'text-slate-400'}`}>
                    <span>• Verified PAN Format</span>
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                    {editingTr ? 'Secure Password (Leave blank to keep current)' : 'Secure Password *'}
                  </label>
                  <input
                    type="password"
                    required={!editingTr}
                    placeholder="••••••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent focus:ring-2 focus:ring-blue-500/20"
                  />
                  <div className="text-[10px] mt-1 font-semibold flex items-center gap-1 text-slate-400">
                    <span>• Secure transporter login password</span>
                  </div>
                </div>

                {editingTr && (
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Carrier Active Status</label>
                    <select
                      value={status}
                      onChange={(e) => setStatus(e.target.value as 'ACTIVE' | 'INACTIVE')}
                      className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent focus:ring-2 focus:ring-blue-500/20 dark:text-white"
                    >
                      <option value="ACTIVE">ACTIVE (Can Authenticate & Bid)</option>
                      <option value="INACTIVE">INACTIVE (Block Login & Senders)</option>
                    </select>
                  </div>
                )}
              </div>

              {/* Vehicle Options Checkboxes */}
              <div className="space-y-2 border-t border-slate-100 dark:border-slate-900 pt-4">
                <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Operating Vehicle Fleets</label>
                <div className="grid grid-cols-2 gap-3">
                  {vehicleOptions.map(veh => {
                    const isChecked = selectedVehicles.includes(veh);
                    return (
                      <div 
                        key={veh}
                        onClick={() => toggleVehicle(veh)}
                        className={`p-3 border rounded-xl flex items-center justify-between cursor-pointer select-none transition-all ${
                          isChecked 
                            ? 'border-blue-500 bg-blue-50/25 dark:bg-blue-950/20' 
                            : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-900/50'
                        }`}
                      >
                        <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">{veh}</span>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          readOnly
                          className="rounded text-blue-600 focus:ring-blue-500"
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            </form>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-slate-100 dark:border-slate-900 flex justify-end gap-3 bg-slate-50/50 dark:bg-slate-900/50">
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="px-4 py-2 text-xs font-semibold bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-800 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                form="trans-form"
                disabled={submitting}
                className="px-4 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-lg shadow-md shadow-blue-500/10 transition-colors cursor-pointer"
              >
                {submitting ? 'Processing Registry Request...' : 'Confirm & Save Registry'}
              </button>
            </div>
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
                onClick={handleExecuteDeleteTransporter}
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
