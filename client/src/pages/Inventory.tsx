// src/pages/Inventory.tsx
import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { API_BASE_URL } from '../lib/api';

interface InventoryItem {
  id: string;
  name: string;
  quantity: number;
  category: string;
}

const Inventory = () => {
  const [items, setItems] = useState<InventoryItem[] | null>(null);

  useEffect(() => {
    axios
      .get(`${API_BASE_URL}/api/inventory`)
      .then((res) => setItems(res.data))
      .catch((err) => console.error('Failed to fetch inventory:', err));
  }, []);

  if (!items) return <p className="p-6">Loading inventory...</p>;

  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold mb-4 text-gray-800">Inventory</h2>
      <table className="w-full text-left bg-white rounded shadow overflow-hidden">
        <thead className="bg-gray-100 text-sm text-gray-700">
          <tr>
            <th className="p-3">Name</th>
            <th className="p-3">Category</th>
            <th className="p-3">Quantity</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-t text-gray-800">
              <td className="p-3">{item.name}</td>
              <td className="p-3">{item.category}</td>
              <td className="p-3">{item.quantity}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default Inventory;
