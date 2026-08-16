import React, { useEffect, useState } from 'react';
import api from '../lib/api';
import { useAuth } from '../components/AuthContext';
import { 
  Plus, 
  Layers, 
  Trash2, 
  Globe, 
  MapPin, 
  Calendar, 
  Truck, 
  Clock, 
  Search, 
  Filter, 
  Send, 
  AlertCircle,
  FileCheck,
  ChevronDown,
  Info,
  X,
  PlusCircle,
  FileText
} from 'lucide-react';
import { Link } from 'react-router-dom';
import ExportAwardPdfButton from '../components/OfficialAwardPdf';

export default function RequirementsList() {
  const { user } = useAuth();
  
  const [requirements, setRequirements] = useState<any[]>([]);
  const [transporters, setTransporters] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // Filter & Search states
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');

  // Custom alert & confirm states
  const [confirmPublishId, setConfirmPublishId] = useState<string | null>(null);
  const [alertMessage, setAlertMessage] = useState<string | null>(null);

  // Deletion Confirmation
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState<string>('');

  const handleExecuteDeleteAuction = async () => {
    if (!deleteConfirmId) return;
    try {
      setSubmitting(true);
      const res = await api.delete(`/v1/admin/requirements/${deleteConfirmId}`);
      setAlertMessage(res.message || 'Bidding auction deleted successfully.');
      setDeleteConfirmId(null);
      setDeleteConfirmName('');
      loadRequirements();
    } catch (err: any) {
      setAlertMessage(err.message || 'Failed to delete bidding auction.');
      setDeleteConfirmId(null);
      setDeleteConfirmName('');
    } finally {
      setSubmitting(false);
    }
  };
  
  // Creation modal state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createMode, setCreateMode] = useState<'single' | 'bulk'>('single');

  // Single requirement form state
  const [singleForm, setSingleForm] = useState({
    pickupLocation: '',
    deliveryLocation: '',
    material: '',
    weight: '',
    vehicleType: 'TRUCK',
    numberOfVehicles: '1',
    pickupDate: '',
    expectedDelivery: '',
    specialInstructions: '',
    vehicleSpecs: '',
    bidClosingTime: '',
    targetRate: '',
    awardType: 'MANUAL' as 'MANUAL' | 'AUTOMATIC',
    eligibleTransporters: [] as string[] // Selected transporter ids
  });

  // Bulk rows state
  const [bulkRows, setBulkRows] = useState<any[]>([
    {
      pickupLocation: '',
      deliveryLocation: '',
      material: '',
      weight: '',
      vehicleType: 'TRUCK',
      numberOfVehicles: '1',
      pickupDate: '',
      expectedDelivery: '',
      specialInstructions: '',
      vehicleSpecs: '',
      bidClosingTime: '',
      targetRate: '',
      awardType: 'MANUAL',
      eligibleTransporters: []
    }
  ]);

  // Standardized vehicle types (single source for the Launch New Bidding Round workflow)
  const vehicleOptions = ['TRUCK', 'DUMPER', 'TRAILER', 'CONTAINER BODY', 'OTHER'];
  // All active transporters are eligible for a round; vehicle category selection was removed.
  const activeTransporterIds = transporters
    .filter(t => t.status === 'ACTIVE')
    .map(t => t.id);

  useEffect(() => {
    loadRequirements();
    if (user?.role !== 'TRANSPORTER') {
      loadTransporters();
    }
  }, [user]);

  async function loadRequirements() {
    try {
      const data = await api.get('/requirements');
      setRequirements(data.requirements || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  async function loadTransporters() {
    try {
      const data = await api.get('/transporters');
      setTransporters(data.transporters || []);
    } catch (e) {
      console.error(e);
    }
  }

  // Handle single submit
  const handleSingleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!singleForm.pickupLocation || !singleForm.deliveryLocation || !singleForm.material || !singleForm.weight || !singleForm.pickupDate || !singleForm.bidClosingTime) {
      setAlertMessage('Please fill in all mandatory fields.');
      return;
    }

    setSubmitting(true);
    try {
      await api.post('/requirements', {
        requirements: [singleForm]
      });
      setShowCreateModal(false);
      resetSingleForm();
      loadRequirements();
    } catch (err: any) {
      setAlertMessage(err.message || 'Failed to create requirement');
    } finally {
      setSubmitting(false);
    }
  };

  const resetSingleForm = () => {
    setSingleForm({
      pickupLocation: '',
      deliveryLocation: '',
      material: '',
      weight: '',
      vehicleType: 'TRUCK',
      numberOfVehicles: '1',
      pickupDate: '',
      expectedDelivery: '',
      specialInstructions: '',
      vehicleSpecs: '',
      bidClosingTime: '',
      targetRate: '',
      awardType: 'MANUAL',
      eligibleTransporters: []
    });
  };

  // Bulk mode handlers
  const handleAddBulkRow = () => {
    setBulkRows([
      ...bulkRows,
      {
        pickupLocation: '',
        deliveryLocation: '',
        material: '',
        weight: '',
        vehicleType: 'TRUCK',
        numberOfVehicles: '1',
        pickupDate: '',
        expectedDelivery: '',
        specialInstructions: '',
        vehicleSpecs: '',
        bidClosingTime: '',
        targetRate: '',
        awardType: 'MANUAL',
        eligibleTransporters: []
      }
    ]);
  };

  const handleRemoveBulkRow = (index: number) => {
    if (bulkRows.length === 1) return;
    setBulkRows(bulkRows.filter((_, idx) => idx !== index));
  };

  const handleBulkRowChange = (index: number, field: string, value: any) => {
    const updated = [...bulkRows];
    updated[index][field] = value;
    
    // Auto populate all active transporters as eligible for the round
    if (field === 'vehicleType') {
      updated[index].eligibleTransporters = activeTransporterIds;
    }
    
    setBulkRows(updated);
  };

  const handleCopyFirstRowToAll = () => {
    if (bulkRows.length <= 1) return;
    const firstRow = { ...bulkRows[0] };
    const copied = bulkRows.map((row, idx) => {
      if (idx === 0) return row;
      return { ...firstRow };
    });
    setBulkRows(copied);
  };

  const handleBulkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Quick validation
    const invalid = bulkRows.some(r => !r.pickupLocation || !r.deliveryLocation || !r.material || !r.weight || !r.pickupDate || !r.bidClosingTime);
    if (invalid) {
      setAlertMessage('Mandatory fields missing in one or more rows. Please review your draft rows.');
      return;
    }

    setSubmitting(true);
    try {
      await api.post('/requirements', {
        requirements: bulkRows
      });
      setShowCreateModal(false);
      setBulkRows([
        {
          pickupLocation: '',
          deliveryLocation: '',
          material: '',
          weight: '',
          vehicleType: 'TRUCK',
          numberOfVehicles: '1',
          pickupDate: '',
          expectedDelivery: '',
          specialInstructions: '',
          vehicleSpecs: '',
          bidClosingTime: '',
          targetRate: '',
          awardType: 'MANUAL',
          eligibleTransporters: []
        }
      ]);
      loadRequirements();
    } catch (err: any) {
      setAlertMessage(err.message || 'Failed to submit bulk rows');
    } finally {
      setSubmitting(false);
    }
  };

  // Actions
  const handlePublish = (id: string) => {
    setConfirmPublishId(id);
  };

  const executePublish = async (id: string) => {
    setConfirmPublishId(null);
    try {
      await api.put(`/requirements/${id}/publish`);
      loadRequirements();
    } catch (err: any) {
      setAlertMessage(err.message || 'Publish failed');
    }
  };

  // Filter lists
  const filteredRequirements = requirements.filter(req => {
    const matchesSearch = 
      req.id.toLowerCase().includes(search.toLowerCase()) ||
      req.pickupLocation.toLowerCase().includes(search.toLowerCase()) ||
      req.deliveryLocation.toLowerCase().includes(search.toLowerCase()) ||
      req.material.toLowerCase().includes(search.toLowerCase());

    const matchesStatus = statusFilter === 'ALL' || 
      (statusFilter === 'LIVE' 
        ? (req.status === 'LIVE' || req.status === 'active' || req.status === 'published')
        : req.status === statusFilter);

    return matchesSearch && matchesStatus;
  });

  return (
    <div className="space-y-6">
      {/* Top Banner Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-950 dark:text-white tracking-tight flex items-center gap-2">
            <FileText className="w-6 h-6 text-slate-400" />
            Requirement Cycles
          </h1>
          <p className="text-slate-400 text-xs mt-1">
            {user?.role === 'TRANSPORTER' 
              ? 'Sealed reverse bidding rounds you are eligible to coordinate.'
              : 'Launch, edit, cancel, and award your logistics bidding rounds.'
            }
          </p>
        </div>

        {user?.role !== 'TRANSPORTER' && user?.status?.toLowerCase() !== 'approved' && (
          <button
            onClick={() => setShowCreateModal(true)}
            className="px-4 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors shadow-md shadow-blue-500/10 flex items-center gap-2 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Create Requirement
          </button>
        )}
      </div>

      {/* FILTER PANEL */}
      <div className="p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl flex flex-col md:flex-row gap-4 items-center justify-between shadow-sm">
        <div className="relative w-full md:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search location, cargo..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:text-white transition-all placeholder-slate-400"
          />
        </div>

        <div className="flex items-center gap-2 w-full md:w-auto">
          <Filter className="w-4 h-4 text-slate-400 shrink-0" />
          <span className="text-xs text-slate-400 font-medium">Status:</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:text-white"
          >
            <option value="ALL">All Cycles</option>
            <option value="DRAFT">Draft</option>
            <option value="LIVE">Live / Bidding Open</option>
            <option value="CLOSED">Bids Closed</option>
            <option value="TIE_RESOLUTION_REQUIRED">Tie Resolution Needed</option>
            <option value="AWARDED">Contract Awarded</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </div>
      </div>

      {/* REQUIREMENTS LIST */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm">
        {loading ? (
          <div className="p-12 text-center text-xs text-slate-400 animate-pulse">
            Loading requirement catalogs...
          </div>
        ) : filteredRequirements.length === 0 ? (
          <div className="p-16 text-center space-y-3">
            <Info className="w-8 h-8 text-slate-300 mx-auto" />
            <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">No Requirements Found</div>
            <p className="text-xs text-slate-400 max-w-sm mx-auto">
              There are currently no active bidding requirements matching your filters.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-900">
            {filteredRequirements.map((req) => {
              const ends = new Date(req.bidClosingTime);
              const isClosed = ends < new Date();

              return (
                <div key={req.id} className="p-6 hover:bg-slate-50/50 dark:hover:bg-slate-900/10 transition-colors">
                  <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
                    {/* Route Details */}
                    <div className="space-y-3 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs font-bold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/30 px-2 py-0.5 rounded">
                          {req.id}
                        </span>
                        
                        <span className="text-base font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                          {req.pickupLocation} 
                          <span className="text-slate-400">&rarr;</span> 
                          {req.deliveryLocation}
                        </span>
                      </div>

                      <div className="grid grid-cols-2 md:grid-cols-4 gap-y-2 gap-x-4">
                        <div className="flex items-center gap-1.5 text-xs text-slate-400">
                          <Truck className="w-3.5 h-3.5" />
                          <span>Vehicle: <strong className="text-slate-700 dark:text-slate-300">{req.vehicleType}</strong></span>
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-slate-400">
                          <Layers className="w-3.5 h-3.5" />
                          <span>Cargo: <strong className="text-slate-700 dark:text-slate-300">{req.material}</strong></span>
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-slate-400">
                          <Info className="w-3.5 h-3.5" />
                          <span>Weight: <strong className="text-slate-700 dark:text-slate-300">{req.weight} Tons</strong></span>
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-slate-400">
                          <Calendar className="w-3.5 h-3.5" />
                          <span>Pickup: <strong className="text-slate-700 dark:text-slate-300">{new Date(req.pickupDate).toLocaleDateString()}</strong></span>
                        </div>
                      </div>

                      {req.vehicleSpecs && (
                        <div className="p-2.5 rounded-lg bg-amber-50/60 dark:bg-amber-950/20 border border-amber-200/60 dark:border-amber-900/30 text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">
                          <span className="font-bold text-amber-600 dark:text-amber-400 uppercase tracking-wider text-[9px]">Vehicle Specs / Remarks: </span>
                          {req.vehicleSpecs}
                        </div>
                      )}
                    </div>

                    {/* Timeline & Status */}
                    <div className="flex flex-wrap items-center gap-6 justify-between lg:justify-end">
                      <div className="space-y-1 text-left lg:text-right">
                        <div className="text-xs text-slate-400 font-medium">Bidding Closes</div>
                        <div className="text-xs font-bold text-slate-700 dark:text-slate-300 flex items-center gap-1 lg:justify-end">
                          <Clock className="w-3.5 h-3.5" />
                          <span>
                            {new Date(req.bidClosingTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ({new Date(req.bidClosingTime).toLocaleDateString()})
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-3">
                        <span className={`px-3 py-1 rounded-full text-[10px] font-bold tracking-wider uppercase ${
                          (req.status === 'LIVE' || req.status === 'active' || req.status === 'published') && !isClosed ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-900/30' :
                          (req.status === 'LIVE' || req.status === 'active' || req.status === 'published') && isClosed ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-900/30' :
                          req.status === 'AWARDED' ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-900/30' :
                          req.status === 'DRAFT' ? 'bg-slate-50 dark:bg-slate-900 text-slate-500 border border-slate-200 dark:border-slate-800' :
                          req.status === 'TIE_RESOLUTION_REQUIRED' ? 'bg-rose-50 dark:bg-rose-950/30 text-rose-500 border border-rose-200 dark:border-rose-900/30 animate-pulse' :
                          'bg-slate-100 dark:bg-slate-800 text-slate-400'
                        }`}>
                          {((req.status === 'LIVE' || req.status === 'active' || req.status === 'published') && isClosed) ? 'Bidding Closed' : req.status.replace(/_/g, ' ')}
                        </span>

                        <div className="flex items-center gap-2">
                          {req.status === 'DRAFT' && user?.role !== 'TRANSPORTER' && user?.status?.toLowerCase() !== 'approved' && (
                            <button
                              onClick={() => handlePublish(req.id)}
                              className="px-3 py-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg shadow transition-colors flex items-center gap-1 cursor-pointer"
                            >
                              <Send className="w-3.5 h-3.5" />
                              Publish
                            </button>
                          )}

                          <Link
                            to={`/bid/${req.id}`}
                            className="px-3 py-1.5 text-xs font-semibold bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700 rounded-lg transition-colors"
                          >
                            Enter Auction
                          </Link>
                          {req.status === 'AWARDED' && (
                            <ExportAwardPdfButton requirement={req} />
                          )}
                          {user?.role === 'SUPER_ADMIN' && (
                            <button
                              onClick={() => {
                                setDeleteConfirmId(req.id);
                                setDeleteConfirmName(`${req.id} (${req.pickupLocation} ➔ ${req.deliveryLocation})`);
                              }}
                              className="p-1.5 rounded-lg border border-rose-200 hover:bg-rose-50 text-rose-500 hover:text-rose-700 dark:border-rose-900/30 dark:hover:bg-rose-950/20 transition-colors cursor-pointer"
                              title="Delete Auction"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* CREATE MODAL */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/60 dark:bg-black/80 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="w-full max-w-5xl bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-2xl flex flex-col max-h-[90vh]">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-900 flex justify-between items-center">
              <div className="space-y-0.5">
                <h3 className="text-base font-bold text-slate-950 dark:text-white">Launch New Bidding Rounds</h3>
                <p className="text-xs text-slate-400">Configure sealed reverse auctions for pre-registered transporters.</p>
              </div>
              <button 
                onClick={() => setShowCreateModal(false)}
                className="p-1 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-400 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Modes Selection */}
            <div className="px-6 py-3 bg-slate-50/50 dark:bg-slate-900/50 border-b border-slate-100 dark:border-slate-900 flex gap-4">
              <button
                onClick={() => setCreateMode('single')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1.5 ${
                  createMode === 'single'
                    ? 'bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400'
                    : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                <FileText className="w-4 h-4" />
                Single Requirement Cycle
              </button>
              <button
                onClick={() => setCreateMode('bulk')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1.5 ${
                  createMode === 'bulk'
                    ? 'bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400'
                    : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                <Layers className="w-4 h-4" />
                Bulk Mode (No limit)
              </button>
            </div>

            {/* Modal Body / Scroll Content */}
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {createMode === 'single' ? (
                /* SINGLE FORM */
                <form id="single-form" onSubmit={handleSingleSubmit} className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Pickup Location *</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Mumbai, MH"
                      value={singleForm.pickupLocation}
                      onChange={(e) => setSingleForm({...singleForm, pickupLocation: e.target.value})}
                      className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent focus:ring-2 focus:ring-blue-500/20"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Delivery Location *</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Delhi, NCR"
                      value={singleForm.deliveryLocation}
                      onChange={(e) => setSingleForm({...singleForm, deliveryLocation: e.target.value})}
                      className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent focus:ring-2 focus:ring-blue-500/20"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Material Cargo *</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Chemical drums"
                      value={singleForm.material}
                      onChange={(e) => setSingleForm({...singleForm, material: e.target.value})}
                      className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent focus:ring-2 focus:ring-blue-500/20"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Total Weight (Tons) *</label>
                    <input
                      type="number"
                      required
                      min={1}
                      placeholder="e.g. 18"
                      value={singleForm.weight}
                      onChange={(e) => setSingleForm({...singleForm, weight: e.target.value})}
                      className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent focus:ring-2 focus:ring-blue-500/20"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Vehicle Type Required</label>
                    <select
                      value={singleForm.vehicleType}
                      onChange={(e) => {
                        const vType = e.target.value;
                        // Prepopulate all active transporters as eligible for the round
                        setSingleForm({...singleForm, vehicleType: vType, eligibleTransporters: activeTransporterIds});
                      }}
                      className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent focus:ring-2 focus:ring-blue-500/20 dark:text-white"
                    >
                      {vehicleOptions.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                    </select>
                  </div>

                  <div className="md:col-span-3">
                    <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Vehicle Specifications / Remarks (Optional)</label>
                    <textarea
                      rows={3}
                      placeholder="Add specific requirements like length, tonnage capacity, side height, open/closed, etc."
                      value={singleForm.vehicleSpecs}
                      onChange={(e) => setSingleForm({...singleForm, vehicleSpecs: e.target.value})}
                      className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent focus:ring-2 focus:ring-blue-500/20 resize-y"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Number of Vehicles</label>
                    <input
                      type="number"
                      min={1}
                      placeholder="1"
                      value={singleForm.numberOfVehicles}
                      onChange={(e) => setSingleForm({...singleForm, numberOfVehicles: e.target.value})}
                      className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent focus:ring-2 focus:ring-blue-500/20"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Pickup Date *</label>
                    <input
                      type="date"
                      required
                      value={singleForm.pickupDate}
                      onChange={(e) => setSingleForm({...singleForm, pickupDate: e.target.value})}
                      className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent focus:ring-2 focus:ring-blue-500/20 dark:text-white"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Bidding Closing Time *</label>
                    <input
                      type="datetime-local"
                      required
                      value={singleForm.bidClosingTime}
                      onChange={(e) => setSingleForm({...singleForm, bidClosingTime: e.target.value})}
                      className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent focus:ring-2 focus:ring-blue-500/20 dark:text-white"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Target/Reserve Rate (Optional)</label>
                    <input
                      type="number"
                      placeholder="e.g. 45000"
                      value={singleForm.targetRate}
                      onChange={(e) => setSingleForm({...singleForm, targetRate: e.target.value})}
                      className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent focus:ring-2 focus:ring-blue-500/20"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Award Policy</label>
                    <select
                      value={singleForm.awardType}
                      onChange={(e) => setSingleForm({...singleForm, awardType: e.target.value as 'MANUAL' | 'AUTOMATIC'})}
                      className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent focus:ring-2 focus:ring-blue-500/20 dark:text-white"
                    >
                      <option value="MANUAL">Manual Award Selection</option>
                      <option value="AUTOMATIC">Auto-Award Single L1</option>
                    </select>
                  </div>

                  {/* Eligible transporters panel */}
                  <div className="md:col-span-3 border-t border-slate-100 dark:border-slate-900 pt-6 space-y-3">
                    <div>
                      <h4 className="text-xs font-bold text-slate-950 dark:text-white uppercase tracking-wider">Per-Round Eligible Transporters selection</h4>
                      <p className="text-xs text-slate-400">Exclude or include specific carriers for this bidding round snapshot.</p>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      {transporters.map(tr => {
                        const isChecked = singleForm.eligibleTransporters.includes(tr.id);

                        return (
                          <div 
                            key={tr.id}
                            onClick={() => {
                              const list = singleForm.eligibleTransporters.includes(tr.id)
                                ? singleForm.eligibleTransporters.filter(id => id !== tr.id)
                                : [...singleForm.eligibleTransporters, tr.id];
                              setSingleForm({...singleForm, eligibleTransporters: list});
                            }}
                            className={`p-3 border rounded-xl flex items-center justify-between cursor-pointer select-none transition-all ${
                              isChecked 
                                ? 'border-blue-500 bg-blue-50/25 dark:bg-blue-950/20' 
                                : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-900/50'
                            }`}
                          >
                            <div>
                              <div className="text-xs font-bold text-slate-800 dark:text-slate-200">{tr.companyName}</div>
                              <div className="text-[10px] font-mono text-slate-400 mt-0.5">{tr.mobileNumber}</div>
                            </div>
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
              ) : (
                /* BULK FORM MODE */
                <form id="bulk-form" onSubmit={handleBulkSubmit} className="space-y-6">
                  <div className="flex justify-between items-center bg-slate-50/50 dark:bg-slate-900/20 p-4 border border-slate-100 dark:border-slate-900 rounded-xl">
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={handleAddBulkRow}
                        className="px-3 py-1.5 text-xs font-semibold bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 rounded-lg hover:bg-blue-100/50 dark:hover:bg-blue-950/70 transition-colors cursor-pointer flex items-center gap-1"
                      >
                        <PlusCircle className="w-3.5 h-3.5" />
                        Add Bidding Row
                      </button>
                      <button
                        type="button"
                        onClick={handleCopyFirstRowToAll}
                        className="px-3 py-1.5 text-xs font-semibold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors cursor-pointer"
                      >
                        Copy First Row to All
                      </button>
                    </div>
                    <span className="text-xs font-mono text-slate-400">{bulkRows.length} Rows Drafting</span>
                  </div>

                  <div className="space-y-4 max-h-[50vh] overflow-y-auto pr-2">
                    {bulkRows.map((row, idx) => (
                      <div 
                        key={idx}
                        className="p-5 border border-slate-200 dark:border-slate-800 rounded-xl relative space-y-4 bg-slate-50/10"
                      >
                        <div className="flex justify-between items-center">
                          <span className="text-xs font-bold text-slate-400 uppercase tracking-wider font-mono">Row #{idx + 1}</span>
                          {bulkRows.length > 1 && (
                            <button
                              type="button"
                              onClick={() => handleRemoveBulkRow(idx)}
                              className="p-1 rounded-lg hover:bg-rose-50 dark:hover:bg-rose-950/30 text-rose-500 transition-colors cursor-pointer"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                          <div>
                            <input
                              type="text"
                              required
                              placeholder="Pickup location"
                              value={row.pickupLocation}
                              onChange={(e) => handleBulkRowChange(idx, 'pickupLocation', e.target.value)}
                              className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent focus:ring-2 focus:ring-blue-500/20"
                            />
                          </div>

                          <div>
                            <input
                              type="text"
                              required
                              placeholder="Delivery location"
                              value={row.deliveryLocation}
                              onChange={(e) => handleBulkRowChange(idx, 'deliveryLocation', e.target.value)}
                              className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent focus:ring-2 focus:ring-blue-500/20"
                            />
                          </div>

                          <div>
                            <input
                              type="text"
                              required
                              placeholder="Cargo material"
                              value={row.material}
                              onChange={(e) => handleBulkRowChange(idx, 'material', e.target.value)}
                              className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent focus:ring-2 focus:ring-blue-500/20"
                            />
                          </div>

                          <div>
                            <input
                              type="number"
                              required
                              placeholder="Weight (Tons)"
                              value={row.weight}
                              onChange={(e) => handleBulkRowChange(idx, 'weight', e.target.value)}
                              className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent focus:ring-2 focus:ring-blue-500/20"
                            />
                          </div>

                          <div>
                            <select
                              value={row.vehicleType}
                              onChange={(e) => handleBulkRowChange(idx, 'vehicleType', e.target.value)}
                              className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent focus:ring-2 focus:ring-blue-500/20 dark:text-white"
                            >
                              {vehicleOptions.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                            </select>
                          </div>

                          <div>
                            <label className="block text-[9px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Pickup Date</label>
                            <input
                              type="date"
                              required
                              value={row.pickupDate}
                              onChange={(e) => handleBulkRowChange(idx, 'pickupDate', e.target.value)}
                              className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent focus:ring-2 focus:ring-blue-500/20 dark:text-white"
                            />
                          </div>

                          <div>
                            <label className="block text-[9px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Bidding Closing Time</label>
                            <input
                              type="datetime-local"
                              required
                              value={row.bidClosingTime}
                              onChange={(e) => handleBulkRowChange(idx, 'bidClosingTime', e.target.value)}
                              className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent focus:ring-2 focus:ring-blue-500/20 dark:text-white"
                            />
                          </div>

                          <div>
                            <input
                              type="number"
                              placeholder="Target Rate (Optional)"
                              value={row.targetRate}
                              onChange={(e) => handleBulkRowChange(idx, 'targetRate', e.target.value)}
                              className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent focus:ring-2 focus:ring-blue-500/20"
                            />
                          </div>

                          <div className="md:col-span-4">
                            <textarea
                              rows={2}
                              placeholder="Vehicle Specifications / Remarks (optional) — e.g. length, tonnage capacity, side height, open/closed"
                              value={row.vehicleSpecs || ''}
                              onChange={(e) => handleBulkRowChange(idx, 'vehicleSpecs', e.target.value)}
                              className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent focus:ring-2 focus:ring-blue-500/20 resize-y"
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </form>
              )}
            </div>

            {/* Modal Footer actions */}
            <div className="px-6 py-4 border-t border-slate-100 dark:border-slate-900 flex justify-end gap-3 bg-slate-50/50 dark:bg-slate-900/50">
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="px-4 py-2 text-xs font-semibold bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-800 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                form={createMode === 'single' ? 'single-form' : 'bulk-form'}
                disabled={submitting}
                className="px-4 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-lg shadow-md shadow-blue-500/10 transition-colors flex items-center gap-1.5 cursor-pointer"
              >
                <FileCheck className="w-4 h-4" />
                {submitting ? 'Creating Bidding Rounds...' : 'Confirm & Launch as Drafts'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CUSTOM CONFIRM PUBLISH MODAL */}
      {confirmPublishId && (
        <div className="fixed inset-0 bg-black/60 dark:bg-black/80 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 text-emerald-500">
              <AlertCircle className="w-8 h-8 shrink-0" />
              <h3 className="text-base font-bold text-slate-950 dark:text-white">Publish Bidding Cycle</h3>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              Are you sure you want to publish this requirement? All invited transporters will receive SMS, WhatsApp, and Email alerts immediately.
            </p>
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setConfirmPublishId(null)}
                className="px-4 py-2 text-xs font-semibold bg-slate-50 hover:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-lg transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => executePublish(confirmPublishId)}
                className="px-4 py-2 text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition-colors cursor-pointer"
              >
                Confirm & Publish
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
                onClick={handleExecuteDeleteAuction}
                className="px-4 py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-700 text-white rounded-lg transition-colors cursor-pointer"
              >
                Permanently Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CUSTOM ALERT MESSAGE MODAL */}
      {alertMessage && (
        <div className="fixed inset-0 bg-black/60 dark:bg-black/80 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 text-blue-600 dark:text-blue-400">
              <Info className="w-6 h-6 shrink-0" />
              <h3 className="text-sm font-bold text-slate-950 dark:text-white">Notification</h3>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              {alertMessage}
            </p>
            <div className="flex justify-end pt-2">
              <button
                onClick={() => setAlertMessage(null)}
                className="px-4 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors cursor-pointer"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
