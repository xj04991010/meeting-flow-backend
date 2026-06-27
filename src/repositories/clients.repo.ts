import { supabase } from '../utils/db';

export type ClientData = {
  id?: string;
  user_id?: string;
  name: string;
  status?: 'active' | 'paused' | 'completed';
  notes?: string;
  contact_info?: any;
  contract_start?: string;
  contract_end?: string;
  default_monthly_target?: number;
};

export async function getClients(userId: string) {
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching clients:', error);
    throw error;
  }
  return data;
}

export async function createClient(userId: string, data: ClientData) {
  const { data: result, error } = await supabase
    .from('clients')
    .insert([{ ...data, user_id: userId }])
    .select()
    .single();

  if (error) {
    console.error('Error creating client:', error);
    throw error;
  }
  return result;
}

export async function updateClient(userId: string, clientId: string, data: Partial<ClientData>) {
  const { data: result, error } = await supabase
    .from('clients')
    .update(data)
    .eq('id', clientId)
    .eq('user_id', userId)
    .select()
    .single();

  if (error) {
    console.error('Error updating client:', error);
    throw error;
  }
  return result;
}
