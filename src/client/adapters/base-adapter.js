export class BaseAdapter {

  async getAll() {
    throw new Error("BaseAdapter.getAll debe implementarse");
  }

  async get() {
    throw new Error("BaseAdapter.get debe implementarse");
  }

  async add() {
    throw new Error("BaseAdapter.add debe implementarse");
  }

  async put() {
    throw new Error("BaseAdapter.put debe implementarse");
  }

  async delete() {
    throw new Error("BaseAdapter.delete debe implementarse");
  }

  async clear() {
    throw new Error("BaseAdapter.clear debe implementarse");
  }
}
