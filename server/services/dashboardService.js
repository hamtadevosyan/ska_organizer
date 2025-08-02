exports.getMetrics = () => {
  // later, replace with database queries
  return {
    totalStudents: 42,
    totalStaff: 6,
    inventoryCount: 120,
    recentActivities: [
      'Outdoor playtime completed',
      'New books added to library',
      'Weekly staff meeting held',
    ]
  };
};
