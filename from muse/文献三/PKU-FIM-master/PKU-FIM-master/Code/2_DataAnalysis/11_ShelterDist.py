# -*-coding:utf-8 -*-
# python 3.9


"""
# @File       : 13_ShelterDist.py
# @software   : PyCharm  
# @Time       ：2025/5/15 9:27
# @Author     ：Wei Lyu
"""

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

def tid_to_row_col(tid, rows, cols): # tid还原行列数
    tid_adj = tid - 1
    row = rows - 1 - (tid_adj // cols)
    col = tid_adj % cols
    return row, col


if __name__ == '__main__':
    path = 'D:/LW/ABM/OutputData'

    cities = ['北京市', '成都市', '重庆市', '大连市', '东莞市', '上海市', '青岛市', '杭州市', '哈尔滨市', '郑州市', '深圳市', '西安市', '长沙市', '武汉市',
              '佛山市', '济南市', '沈阳市', '广州市', '天津市', '昆明市', '南京市']

    sigma = 1

    for i in range(len(cities)):
        # i = 0
        city = cities[i]
        print('-' * 20, city, '-' * 20)

        param_path = path + '/Result/cities_21_max/' + city
        input_param = pd.read_csv(param_path + '/inputParam.csv', index_col=0, header=None)
        rows = int(input_param.iloc[3, 0]); cols = int(input_param.iloc[4, 0])

        data_path = path + '/Result/cities_21_max/' + city + '/sigma=' + str(sigma)
        df_shelter = pd.read_csv(data_path + '/inflowPredShelter.csv', header=0, usecols=['Tid', 'Shelter_count'])
        df_shelter = df_shelter[df_shelter['Shelter_count'] != 0].copy()

        df_model = pd.read_csv(param_path + '/model_input.csv', header=0)
        df_model = df_model[df_model['Tid'] != -2].copy()

        df_model[['row', 'col']] = df_model['Tid'].apply(lambda t: pd.Series(tid_to_row_col(t, rows, cols)))
        df_shelter[['row', 'col']] = df_shelter['Tid'].apply(lambda t: pd.Series(tid_to_row_col(t, rows, cols)))

        # 构建 KDTree
        shelter_coords = df_shelter[['row', 'col']].values
        tree = cKDTree(shelter_coords)
        shelter_tids_set = set(df_shelter['Tid'])
        shelter_tid_array = df_shelter['Tid'].values

        # 计算最近其他 shelter 的距离（欧式 * cell_size）
        tid_to_dist = {}
        cell_size = 1 # km
        for _, row in df_model.iterrows():
            tid = row['Tid']
            point = np.array([row['row'], row['col']])
            if tid in shelter_tids_set:
                # 自己是 shelter，排除自身
                idx = np.where(shelter_tid_array != tid)[0]
                if len(idx) > 0:
                    reduced_tree = cKDTree(shelter_coords[idx])
                    dist_grid, _ = reduced_tree.query(point, k=1)
                else:
                    dist_grid = np.nan
            else:
                dist_grid, _ = tree.query(point, k=1)

            tid_to_dist[tid] = dist_grid * cell_size

        df_dist = pd.DataFrame(list(tid_to_dist.items()), columns=['Tid', 'Dist_km']) # 单位是1km
        df_dist['Tid'] = df_dist['Tid'].apply(int)
        df_dist.to_csv(param_path + '\\' + "tid_to_shelter_distance.csv", index=False, header=True)

        print(dict(list(tid_to_dist.items())[:10]))

