# -*-coding:utf-8 -*-
# python 3.9
# 提取2018POI、2021POI中的shelter，为后续准备attraction中的shelter赋权+


"""
# @File       : 3_ShelterFromPOI_Cali&Vali.py
# @software   : PyCharm  
# @Time       ：2025/3/26 9:25
# @Author     ：Wei Lyu
"""

import pandas as pd
import numpy as np
import os
import csv

def is_emergency_shelter(type_str):
    try:
        parts = type_str.split(';')
        if len(parts) != 3:
            parts = type_str.split(',')
        return len(parts) > 1 and parts[1] == '紧急避难场所'
    except:
        return False

if __name__ == '__main__':
    base_path = r'D:\LW\ABM'
    ## 处理深圳市POI

    # 先从2018POI里提取出深圳市的POI
    # folder_path = base_path + r'\Data\2018POI'
    # output_file = 'poi2018_shenzhen.csv'  # 输出结果文件名
    #
    # # 初始化一个空的列表来存储筛选后的数据
    # filtered_data = []
    #
    # # 遍历文件夹中的所有CSV文件
    # for file_name in os.listdir(folder_path):
    #     if file_name.endswith('.csv'):
    #         file_path = os.path.join(folder_path, file_name)
    #         # 读取CSV文件
    #         try:
    #             df = pd.read_csv(file_path, header=0, encoding='gbk', quoting=csv.QUOTE_NONE)  # 如果编码错误可以尝试 'gbk'
    #             # 筛选条件
    #             filtered_df = df[(df['pname'] == '广东省') & (df['cityname'] == '深圳市')]
    #
    #             if not filtered_df.empty:
    #                 filtered_data.append(filtered_df)
    #                 print(f"成功读取文件{file_name}")
    #         except Exception as e:
    #             print(f"读取文件 {file_name} 时出错：{e}")
    #
    # # 合并所有筛选后的数据并保存
    # if filtered_data:
    #     result_df = pd.concat(filtered_data, ignore_index=True)
    #     result_df.to_csv(base_path + r'\OutputData\shenzhen\shenzhen' + '\\' + output_file, index=False, encoding='utf-8')
    #     print(f"筛选后的数据已保存到 {output_file}")
    # else:
    #     print("没有找到符合条件的数据。")


    # --------------------------------------------------------------------------------------------

    # 筛选出应急避难场所
    # df = pd.read_csv(base_path + r'\OutputData\shenzhen\poi2018_shenzhen.csv', header=0)
    #
    # # 应用函数进行筛选
    # filtered_df = df[df['type'].apply(is_emergency_shelter)].copy()
    # # 拆分 location 列为 longitude（经度）和 latitude（纬度）
    # split_location = filtered_df['location'].str.split('，', expand=True)
    # split_location.columns = ['longitude', 'latitude']
    #
    # filtered_df.loc[:, 'longitude'] = split_location['longitude'].astype(float)
    # filtered_df.loc[:, 'latitude'] = split_location['latitude'].astype(float)
    #
    # # 保存结果
    # filtered_df.to_csv(base_path + '\OutputData\shenzhen\poi2018_shelters_shenzhen.csv', index=False, encoding='utf-8')
    # print(f"筛选后共找到 {len(filtered_df)} 条紧急避难场所记录，结果已保存为 shelters_shenzhen.csv")

    # --------------------------------------------------------------------------------------------

    ## 处理郑州市POI
    df = pd.read_csv(base_path + r'\Data\2021POI\2021高德地图POI\150-郑州市-870077.csv', header=0, dtype={14: str})
    filtered_df = df[df['类别'].apply(is_emergency_shelter)].copy()
    split_location = filtered_df['经纬度'].str.strip('[]').str.split(',', expand=True)
    split_location.columns = ['longitude', 'latitude']

    filtered_df.loc[:, 'longitude'] = split_location['longitude'].astype(float)
    filtered_df.loc[:, 'latitude'] = split_location['latitude'].astype(float)

    filtered_df.to_csv(base_path + r'\OutputData\zhengzhou\poi2021_shelters_zhengzhou.csv', index=False, encoding='utf-8')